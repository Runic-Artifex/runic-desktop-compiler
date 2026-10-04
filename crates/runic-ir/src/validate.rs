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
    "i", "code", "pre", "br", "hr", "textarea", "label", "select", "option", "svg", "g", "path",
    "circle", "ellipse", "line", "polyline", "polygon", "rect",
];

/// Inline SVG (M5): elements in the SVG namespace. Blitz renders an `<svg>`
/// as a replaced element by serialising its subtree's attributes (with
/// `currentColor` resolved from each element's CSS `color`) and rendering
/// them with usvg, so only attributes whose meaning usvg and Chromium share
/// are accepted (docs/IR.md, "Inline SVG").
pub const SVG_TAGS: &[&str] = &[
    "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect",
];

/// The only value of an `xmlns` attribute (the element's own namespace).
pub const SVG_NAMESPACE: &str = "http://www.w3.org/2000/svg";

/// Inherited paint properties, as presentation attributes on any SVG element.
const SVG_PAINT: &[&str] = &[
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-opacity",
];

/// The attributes an SVG element accepts besides `SVG_PAINT`, `aria-*` and
/// `data-*`. The root's box is laid out by Blitz: its `width` and `height`
/// are CSS sizes in both engines, and attributes that Chromium applies to
/// the outer box but Blitz only to the drawing (`opacity`, `transform`,
/// `display`, `style`, …) are not accepted.
fn svg_attrs(tag: &str) -> &'static [&'static str] {
    match tag {
        "svg" => &["xmlns", "width", "height", "viewBox", "class", "id", "role"],
        "g" => &["class", "opacity", "transform"],
        "path" => &["class", "opacity", "transform", "d"],
        "circle" => &["class", "opacity", "transform", "cx", "cy", "r"],
        "ellipse" => &["class", "opacity", "transform", "cx", "cy", "rx", "ry"],
        "line" => &["class", "opacity", "transform", "x1", "y1", "x2", "y2"],
        "polyline" | "polygon" => &["class", "opacity", "transform", "points"],
        "rect" => &[
            "class",
            "opacity",
            "transform",
            "x",
            "y",
            "width",
            "height",
            "rx",
            "ry",
        ],
        _ => &[],
    }
}

fn svg_attr_ok(tag: &str, name: &str) -> bool {
    let data = |prefix: &str| {
        name.strip_prefix(prefix)
            .is_some_and(|rest| !rest.is_empty() && attr_name_ok(&format!("a{rest}")))
    };
    svg_attrs(tag).contains(&name) || SVG_PAINT.contains(&name) || data("aria-") || data("data-")
}

/// HTML's ASCII whitespace: text that SVG rendering ignores.
fn is_whitespace_text(e: &Expr) -> bool {
    matches!(e, Expr::Lit { value: Value::String(s) }
        if s.chars().all(|c| matches!(c, ' ' | '\t' | '\n' | '\x0C' | '\r')))
}

/// The SVG rules of an element: where it may stand, and what it may carry.
/// `managed`: whether the element has a ref, a spread and a managed inline
/// style (live properties are checked with the other elements).
fn check_svg(
    tag: &str,
    stack: &[&str],
    attrs: &[Attr],
    listeners: &[Listener],
    managed: (bool, bool, bool),
    src: Option<&Source>,
) -> Result<()> {
    let svg = SVG_TAGS.contains(&tag);
    let inside = stack.contains(&"svg");
    if !svg {
        if inside {
            return err(
                "E_SVG",
                format!("<{tag}> inside <svg> is unsupported (only SVG shapes and groups)"),
                src,
            );
        }
        return Ok(());
    }
    if tag == "svg" && inside {
        return err("E_SVG", "Nested <svg> elements are unsupported", src);
    }
    // Without a viewBox, Chromium draws the content unscaled in a box of
    // another size, while Blitz scales the drawing into the box.
    if tag == "svg" && !attrs.iter().any(|a| a.name == "viewBox") {
        return err("E_SVG", "An <svg> needs a viewBox", src);
    }
    if tag != "svg" && !matches!(stack.last(), Some(&("svg" | "g"))) {
        return err(
            "E_SVG",
            format!("<{tag}> must be a child of <svg> or <g>"),
            src,
        );
    }
    let (reference, spread, styled) = managed;
    if !listeners.is_empty() || spread {
        return err(
            "E_SVG",
            "Listeners and spread attributes on SVG elements are unsupported (Blitz hit-tests an inline <svg> as one box)",
            src,
        );
    }
    if reference {
        return err("E_SVG", "Refs to SVG elements are unsupported", src);
    }
    if styled {
        return err(
            "E_SVG",
            "Inline styles on SVG elements are unsupported (Blitz renders SVG from its attributes)",
            src,
        );
    }
    for a in attrs {
        if !svg_attr_ok(tag, &a.name) {
            return err(
                "E_SVG",
                format!(
                    "Attribute {} on <{tag}> is unsupported (supported: {}, the paint attributes {}, aria-* and data-*)",
                    a.name,
                    svg_attrs(tag).join(", "),
                    SVG_PAINT.join(", ")
                ),
                src,
            );
        }
        if a.name == "xmlns"
            && !matches!(&a.value, Expr::Lit { value: Value::String(s) } if s == SVG_NAMESPACE)
        {
            return err(
                "E_SVG",
                format!("xmlns must be the literal {SVG_NAMESPACE}"),
                src,
            );
        }
    }
    Ok(())
}

pub const CAPABILITIES: &[&str] = &["dom", "css", "window", "click", "keyboard", "text-input"];

/// Elements without children (a textarea's text is its live value; SVG
/// shapes draw no content).
const VOID: &[&str] = &[
    "input", "br", "hr", "textarea", "path", "circle", "ellipse", "line", "polyline", "polygon",
    "rect",
];

fn err<T>(code: &str, message: impl Into<String>, source: Option<&Source>) -> Result<T> {
    Err(Diagnostic::new(code, message, source))
}

/// Literal arguments of host-service built-ins (docs/design/M5-PLATFORM.md):
/// - a console call whose first argument is a string followed by more
///   arguments uses it as a format string: Chromium converts the arguments
///   of `%d`/`%i`/`%f`/`%s` in its message text while DevTools substitutes
///   them, so the first argument must then be a literal without `%`;
/// - `history.go` takes a non-zero integer literal (`go(0)` reloads).
fn check_host_literals(name: &str, args: &[Expr], src: Option<&Source>) -> Result<()> {
    if name.starts_with("console.") && args.len() > 1 {
        let format = match &args[0] {
            Expr::Lit {
                value: Value::String(s),
            } => Some(s.contains('%')),
            Expr::Lit { .. } => Some(false),
            _ => None,
        };
        // Non-literal first arguments are checked by type in the scope.
        if format == Some(true) {
            return err(
                "E_BUILTIN",
                "A console format string (a first string argument with % followed by more arguments) is unsupported: Chromium's message text keeps the format and converts the arguments, while DevTools substitutes them",
                src,
            );
        }
    }
    if name == "history.go" {
        let ok = matches!(args.first(), Some(Expr::Lit { value: Value::Number(n) }) if *n != 0.0 && n.fract() == 0.0 && n.abs() < 1e9);
        if !ok {
            return err(
                "E_BUILTIN",
                "history.go takes a non-zero integer literal (go(0) reloads the page)",
                src,
            );
        }
    }
    Ok(())
}

/// The literal arguments of the RegExp built-ins: flags are a literal
/// without `v` (unsupported), a literal pattern compiles, a capture count
/// and a group name are literals.
fn check_regexp_literals(name: &str, args: &[Expr], src: Option<&Source>) -> Result<()> {
    let lit_string = |e: Option<&Expr>| match e {
        Some(Expr::Lit {
            value: Value::String(s),
        }) => Some(s.clone()),
        _ => None,
    };
    match name {
        "regexp.new" => {
            let Some(flags) = lit_string(args.get(1)) else {
                return err("E_REGEXP", "RegExp flags must be a literal", src);
            };
            if flags.contains('v') {
                return err(
                    "E_REGEXP",
                    "The v flag (unicodeSets) is unsupported; use u",
                    src,
                );
            }
            let flags = runic_js::JsString::from(flags.as_str());
            let pattern = lit_string(args.first());
            let checked = match &pattern {
                Some(p) => {
                    runic_js::RegExp::new(&runic_js::JsString::from(p.as_str()), &flags).map(|_| ())
                }
                None => match runic_js::regexp::Flags::parse(flags.units()) {
                    Some(_) => Ok(()),
                    None => runic_js::RegExp::new(&runic_js::JsString::new(), &flags).map(|_| ()),
                },
            };
            if let Err(t) = checked {
                return err("E_REGEXP", t.to_string(), src);
            }
        }
        "string.regexp-replace" | "string.regexp-replaceAll" if args.len() == 4 => {
            let ok = matches!(&args[3], Expr::Lit { value: Value::Number(n) } if *n >= 0.0 && n.fract() == 0.0);
            if !ok {
                return err("E_REGEXP", "The capture count must be a literal", src);
            }
        }
        "match.group" if lit_string(args.get(1)).is_none() => {
            return err("E_REGEXP", "A group name must be a literal", src);
        }
        _ => {}
    }
    Ok(())
}

/// The option string of the `intl.*` built-ins is a literal the runtime
/// accepts: verified locales, options and option combinations only.
fn check_intl_literals(name: &str, args: &[Expr], src: Option<&Source>) -> Result<()> {
    let index = if name == "intl.compare" { 2 } else { 1 };
    let Some(Expr::Lit {
        value: Value::String(spec),
    }) = args.get(index)
    else {
        return err(
            "E_INTL",
            format!("{name}: the options must be a literal"),
            src,
        );
    };
    let checked = match name {
        "intl.format-date" => runic_js::intl::DateSpec::parse(spec).map(|_| ()),
        "intl.format-number" => runic_js::intl::NumberSpec::parse(spec).map(|_| ()),
        "intl.compare" => runic_js::intl::CollatorSpec::parse(spec).map(|_| ()),
        _ => Ok(()),
    };
    checked.or_else(|m| err("E_INTL", m, src))
}

/// A replacement function for a pattern with `n` captures takes the match,
/// the captures (`string`, or `string | undefined`), the position and the
/// string, or a prefix of them.
fn check_replacer(f: &FnType, n: usize, src: Option<&Source>) -> Result<()> {
    let maybe_string = Type::maybe(Type::String);
    for (i, p) in f.params.iter().enumerate() {
        let ok = match i {
            0 => *p == Type::String,
            i if i <= n => *p == Type::String || *p == maybe_string,
            i if i == n + 1 => *p == Type::Number,
            i if i == n + 2 => *p == Type::String,
            _ => false,
        };
        if !ok {
            return err(
                "E_BUILTIN",
                format!(
                    "Replacement function parameter {} has type {} (a pattern with {n} captures passes the match, the captures, the position and the string)",
                    i + 1,
                    p.name()
                ),
                src,
            );
        }
    }
    Ok(())
}

/// The typing context of an expression or statement.
struct Scope<'a> {
    program: &'a Program,
    component: Option<usize>,
    /// Cells readable here (initialisers see only earlier cells).
    visible: usize,
    locals: Vec<Local>,
    /// The event payload type in handlers.
    payload: Option<Type>,
    /// In a handler (or a closure in it): `event` is available.
    handler: bool,
    result: Option<Type>,
    labels: Vec<Option<String>>,
    count: usize,
    /// In templates: which template locals are bound by enclosing nodes.
    bound: Option<Vec<bool>>,
    /// Globals readable here (a global's initialiser sees only earlier ones).
    globals: usize,
}

impl<'a> Scope<'a> {
    fn new(program: &'a Program, component: Option<usize>) -> Self {
        Scope {
            program,
            component,
            visible: component.map_or(0, |c| program.components[c].cells.len()),
            locals: vec![],
            payload: None,
            handler: false,
            result: None,
            labels: vec![],
            count: 0,
            bound: None,
            globals: program.globals.len(),
        }
    }

    /// The typing scope of a template expression with `bound` template locals.
    fn template(program: &'a Program, component: usize, bound: &[bool]) -> Self {
        let mut s = Scope::new(program, Some(component));
        s.locals = program.components[component].template_locals.clone();
        s.bound = Some(bound.to_vec());
        s
    }

    fn local(&self, i: usize, src: Option<&Source>) -> Result<&Local> {
        if let Some(bound) = &self.bound {
            if !bound.get(i).copied().unwrap_or(false) {
                return err("E_IR", format!("Template local {i} is not bound here"), src);
            }
        }
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
            Global { global } => {
                if *global >= self.globals {
                    return err(
                        "E_IR",
                        format!("Invalid or forward global reference {global}"),
                        src,
                    );
                }
                self.program.globals[*global].ty.clone()
            }
            Local { local } => self.local(*local, src)?.ty.clone(),
            Event => {
                if !self.handler {
                    return err("E_IR", "The event object outside a handler", src);
                }
                Type::Event
            }
            Payload => {
                let Some(t) = self.payload.clone() else {
                    return err(
                        "E_IR",
                        "Event payload outside a handler with a payload",
                        src,
                    );
                };
                t
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
                let inner = match &t {
                    Type::Maybe(i) => i,
                    other => other,
                };
                if let Type::Record(r) = inner {
                    if self.program.records.get(*r).is_some_and(|rec| rec.class) {
                        return err(
                            "E_CLASS",
                            format!(
                                "A {} instance is converted to a string; its toString method is not dispatched (call a method that returns the text)",
                                self.program.records[*r].name
                            ),
                            src,
                        );
                    }
                }
                Type::String
            }
            ToNumber { arg } => {
                let t = self.infer(arg, d, src)?;
                // A Date converts through valueOf.
                if !primitive(&t) && t != Type::Date {
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
            Attrs { items, .. } => {
                for item in items {
                    match item {
                        AttrItem::Spread { spread } => self.expect(spread, Type::Attrs, d, src)?,
                        AttrItem::Entry { name, value } => {
                            let t = self.infer(value, d, src)?;
                            let ok = match name.strip_prefix("on").and_then(EventKind::parse) {
                                Some(_) => matches!(
                                    &t,
                                    Type::Fn(f) if f.params.is_empty() || f.params == [Type::Event]
                                ),
                                None => {
                                    attr_name_ok(name)
                                        && (matches!(t, Type::String | Type::Boolean)
                                            || t == Type::maybe(Type::String))
                                }
                            };
                            if !ok {
                                return err(
                                    "E_IR",
                                    format!("Attribute bag entry {name} cannot be {}", t.name()),
                                    src,
                                );
                            }
                        }
                    }
                }
                Type::Attrs
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
            Closure {
                function,
                captures,
                stable,
            } => {
                if *stable && !captures.is_empty() {
                    return err("E_IR", "Stable closures capture nothing", src);
                }
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
                if name == "media.matches" || name == "media.query" {
                    let supported = match args.first() {
                        Some(Lit {
                            value: Value::String(q),
                        }) => {
                            runic_css::media_matches(q, &runic_css::MediaEnv::default()).is_some()
                        }
                        _ => false,
                    };
                    if !supported {
                        return err(
                            "E_BUILTIN",
                            "matchMedia takes a literal query of supported features (prefers-color-scheme, prefers-contrast, prefers-reduced-motion, width, height, orientation)",
                            src,
                        );
                    }
                }
                if name == "element.scrollIntoView" {
                    let aligned = args.len() == 3
                        && args[1..].iter().all(|a| {
                            matches!(a, Lit { value: Value::String(p) }
                            if matches!(p.as_str(), "start" | "center" | "end" | "nearest"))
                        });
                    if !aligned {
                        return err(
                            "E_BUILTIN",
                            "scrollIntoView takes literal alignments (start, center, end, nearest)",
                            src,
                        );
                    }
                }
                if matches!(
                    name.as_str(),
                    "window.listen" | "window.unlisten" | "document.listen" | "document.unlisten"
                ) {
                    let kind = match args.first() {
                        Some(Lit {
                            value: Value::String(k),
                        }) => EventKind::parse(k),
                        _ => None,
                    };
                    if kind.is_none() {
                        return err(
                            "E_BUILTIN",
                            format!("{name}: the event kind must be a supported event name"),
                            src,
                        );
                    }
                    if kind.is_some_and(EventKind::window_only) && name.starts_with("document.") {
                        return err(
                            "E_BUILTIN",
                            "resize, popstate and hashchange are fired at the window only",
                            src,
                        );
                    }
                }
                check_host_literals(name, args, src)?;
                if name.starts_with("regexp.")
                    || name.starts_with("string.regexp-")
                    || name.starts_with("match.")
                {
                    check_regexp_literals(name, args, src)?;
                }
                if name.starts_with("intl.") {
                    check_intl_literals(name, args, src)?;
                }
                let types = args
                    .iter()
                    .map(|a| self.infer(a, d, src))
                    .collect::<Result<Vec<_>>>()?;
                if name.starts_with("console.")
                    && args.len() > 1
                    && (types[0] == Type::String || types[0] == Type::Maybe(Box::new(Type::String)))
                    && !matches!(&args[0], Lit { .. } | Undefined { .. } | Null { .. })
                {
                    return err(
                        "E_BUILTIN",
                        "A console call with more than one argument needs a first argument that is not a string, or a string literal without %: Chromium treats a first string argument as a format string",
                        src,
                    );
                }
                if let (
                    Some(Type::Fn(f)),
                    Some(Lit {
                        value: Value::Number(n),
                    }),
                ) = (types.get(2), args.get(3))
                {
                    if name.starts_with("string.regexp-replace") {
                        check_replacer(f, *n as usize, src)?;
                    }
                }
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
    payload: Option<Type>,
    e: &Expr,
) -> Type {
    let mut s = Scope::new(program, component);
    s.locals = locals.to_vec();
    s.payload = payload;
    s.handler = true;
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
    if p.root >= p.components.len() {
        return err("E_IR", "The root component does not exist", None);
    }
    unconditional_cycles(p)?;
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
        s.block(&f.body).map_err(|d| d.or_source(src))?;
    }
    for (i, g) in p.globals.iter().enumerate() {
        let src = g.source.as_ref();
        let mut s = Scope::new(p, None);
        s.globals = i;
        s.check_type(&g.ty, src)?;
        if s.infer(&g.init, 0, src)? != g.ty {
            return err(
                "E_IR",
                format!("Initialiser type differs from global {}", g.name),
                src,
            );
        }
    }
    let mut nodes = 0;
    for ci in 0..p.components.len() {
        validate_component(p, ci, &mut nodes)?;
    }
    derived_host_services(p)?;
    untracked_template_reads(p)
}

/// Derived values must not use host services (directly or through the
/// functions they call): the frameworks compute them when they are read,
/// so console lines, random values and history reads would depend on how
/// often the view reads them.
fn derived_host_services(p: &Program) -> Result<()> {
    for f in p.functions.iter().filter(|f| f.derived) {
        let mut exprs = vec![];
        collect_exprs(&f.body, &mut exprs);
        let mut seen = HashSet::new();
        let mut found = None;
        for e in exprs {
            reads(p, f.component, e, &mut seen, &mut |r| {
                if let Root::Host(what) = r {
                    found.get_or_insert(what);
                }
            });
        }
        if let Some(what) = found {
            return err(
                "E_REACTIVITY",
                format!(
                    "{what} is used in a derived value; the frameworks compute derived values when they are read (use it in a handler or an effect)"
                ),
                f.source.as_ref(),
            );
        }
    }
    Ok(())
}

/// Reject components that instantiate themselves without a condition or list
/// in between (their mount would not terminate).
fn unconditional_cycles(p: &Program) -> Result<()> {
    fn children(nodes: &[Node], out: &mut Vec<(usize, Option<Source>)>) {
        for n in nodes {
            match n {
                Node::Component {
                    component,
                    source,
                    slots,
                    ..
                } => {
                    out.push((*component, source.clone()));
                    for s in slots {
                        children(&s.body, out);
                    }
                }
                Node::Element { children: c, .. } => children(c, out),
                _ => {}
            }
        }
    }
    let n = p.components.len();
    let edges: Vec<Vec<(usize, Option<Source>)>> = p
        .components
        .iter()
        .map(|c| {
            let mut out = vec![];
            children(&c.template, &mut out);
            out
        })
        .collect();
    for (_, e) in edges.iter().enumerate() {
        for (c, src) in e {
            if *c >= n {
                return err("E_IR", format!("Unknown component {c}"), src.as_ref());
            }
        }
    }
    // Depth-first search for a cycle.
    fn visit(i: usize, edges: &[Vec<(usize, Option<Source>)>], state: &mut [u8]) -> Result<()> {
        state[i] = 1;
        for (c, src) in &edges[i] {
            match state[*c] {
                1 => {
                    return err(
                        "E_IR",
                        "A component instantiates itself unconditionally",
                        src.as_ref(),
                    );
                }
                0 => visit(*c, edges, state)?,
                _ => {}
            }
        }
        state[i] = 2;
        Ok(())
    }
    let mut state = vec![0u8; n];
    for i in 0..n {
        if state[i] == 0 {
            visit(i, &edges, &mut state)?;
        }
    }
    Ok(())
}

fn validate_component(p: &Program, ci: usize, nodes: &mut usize) -> Result<()> {
    let c = &p.components[ci];
    if c.cells.len() > MAX_CELLS || c.handlers.len() > MAX_HANDLERS {
        return err(
            "E_RESOURCE",
            "Too many cells or handlers in a component",
            None,
        );
    }
    let mut slot_names = HashSet::new();
    for d in &c.slots {
        if !slot_names.insert(d.name.as_str()) {
            return err("E_IR", format!("Duplicate slot {}", d.name), None);
        }
        for t in &d.params {
            Scope::new(p, None).check_type(t, None)?;
        }
    }
    let mut props = HashSet::new();
    for l in &c.template_locals {
        Scope::new(p, None).check_type(&l.ty, None)?;
    }
    for (i, cell) in c.cells.iter().enumerate() {
        let src = cell.source.as_ref();
        if let Some(name) = &cell.prop {
            if name.is_empty() || !props.insert(name.as_str()) {
                return err("E_IR", format!("Empty or duplicate prop {name}"), src);
            }
        }
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
    // Locals bound by `each` nodes are visible only in their bodies; the other
    // template locals are temporaries of template expressions.
    fn each_locals(nodes: &[Node], out: &mut HashSet<usize>) {
        for n in nodes {
            match n {
                Node::Each {
                    item,
                    index,
                    body,
                    otherwise,
                    ..
                } => {
                    out.insert(*item);
                    out.extend(*index);
                    each_locals(body, out);
                    each_locals(otherwise, out);
                }
                Node::If {
                    then, otherwise, ..
                } => {
                    each_locals(then, out);
                    each_locals(otherwise, out);
                }
                Node::Element { children, .. } => each_locals(children, out),
                Node::Component { slots, .. } => {
                    for s in slots {
                        out.extend(s.params.iter().copied());
                        each_locals(&s.body, out);
                    }
                }
                Node::Slot { fallback, .. } => each_locals(fallback, out),
                Node::Text { .. } => {}
            }
        }
    }
    let mut scoped = HashSet::new();
    each_locals(&c.template, &mut scoped);
    let mut bound: Vec<bool> = (0..c.template_locals.len())
        .map(|i| !scoped.contains(&i))
        .collect();
    for node in &c.template {
        let mut cx = NodeCx {
            p,
            ci,
            nodes: &mut *nodes,
            used: &mut used,
            stack: &mut stack,
            bound: &mut bound,
        };
        cx.node(node, None, 0)?;
    }
    for (i, h) in c.handlers.iter().enumerate() {
        let src = h.source.as_ref();
        if !used[i] {
            return err("E_IR", "Handler is not referenced by any listener", src);
        }
        let mut s = Scope::new(p, Some(ci));
        s.locals = h.params.iter().chain(&h.locals).cloned().collect();
        s.payload = h.event.payload();
        s.handler = true;
        s.result = Some(Type::Void);
        for l in &s.locals {
            s.check_type(&l.ty, src)?;
        }
        s.block(&h.body).map_err(|d| d.or_source(src))?;
    }
    for e in &c.effects {
        validate_effect(p, ci, e)?;
        if e.render
            && (e.phase != EffectPhase::Pre
                || e.deps != EffectDeps::Tracked
                || p.functions[e.run].result != Type::Void)
        {
            return err(
                "E_IR",
                "A render effect is a tracked pre effect without a cleanup",
                e.source.as_ref(),
            );
        }
    }
    if c.effects.iter().filter(|e| e.render).count() > 1 {
        return err("E_IR", "A component has at most one render effect", None);
    }
    Ok(())
}

/// An effect runs a function of its component; with `values` dependencies it
/// may receive the new and previous values. It returns nothing or a cleanup.
fn validate_effect(p: &Program, ci: usize, e: &Effect) -> Result<()> {
    let src = e.source.as_ref();
    let Some(f) = p.functions.get(e.run) else {
        return err("E_IR", "Unknown effect function", src);
    };
    if f.component != Some(ci) || !f.captures.is_empty() {
        return err(
            "E_IR",
            "An effect runs a function of its own component without captures",
            src,
        );
    }
    let mut values = vec![];
    if let EffectDeps::Values { values: exprs, .. } = &e.deps {
        for v in exprs {
            values.push(Scope::new(p, Some(ci)).infer(v, 0, src)?);
        }
    }
    let params: Vec<&Type> = f.params.iter().map(|l| &l.ty).collect();
    let with_values: Vec<Type> = values
        .iter()
        .cloned()
        .chain(values.iter().map(|t| match t {
            Type::Maybe(_) => t.clone(),
            _ => Type::Maybe(Box::new(t.clone())),
        }))
        .collect();
    if !params.is_empty() && params != with_values.iter().collect::<Vec<_>>() {
        return err(
            "E_IR",
            "Effect functions take no parameters or the new and previous dependency values",
            src,
        );
    }
    let cleanup = Type::Fn(FnType {
        params: vec![],
        result: Box::new(Type::Void),
    });
    let ok = f.result == Type::Void
        || f.result == cleanup
        || f.result == Type::Maybe(Box::new(cleanup.clone()));
    if !ok {
        return err(
            "E_IR",
            "Effect functions return nothing or a cleanup function",
            src,
        );
    }
    Ok(())
}

/// Template validation state of one component.
struct NodeCx<'a, 'p> {
    p: &'p Program,
    ci: usize,
    nodes: &'a mut usize,
    used: &'a mut [bool],
    stack: &'a mut Vec<&'static str>,
    /// Template locals bound by enclosing `each` nodes.
    bound: &'a mut Vec<bool>,
}

impl<'p> NodeCx<'_, 'p> {
    fn scope(&self) -> Scope<'p> {
        Scope::template(self.p, self.ci, self.bound)
    }

    fn nodes(&mut self, list: &[Node], src: Option<&Source>, depth: usize) -> Result<()> {
        list.iter().try_for_each(|n| self.node(n, src, depth + 1))
    }

    /// Bind template local `i` (of type `ty`) for the duration of `f`.
    fn bind<T>(
        &mut self,
        i: usize,
        ty: &Type,
        src: Option<&Source>,
        f: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        let c = &self.p.components[self.ci];
        let Some(l) = c.template_locals.get(i) else {
            return err("E_IR", format!("Unknown template local {i}"), src);
        };
        if self.bound[i] {
            return err(
                "E_IR",
                format!("Template local {i} is bound twice or used as a temporary"),
                src,
            );
        }
        if l.ty != *ty {
            return err(
                "E_IR",
                format!("Template local {} must be {}", l.name, ty.name()),
                src,
            );
        }
        self.bound[i] = true;
        let r = f(self);
        self.bound[i] = false;
        r
    }

    /// Bind several template locals with the given types for the duration of `f`.
    fn bind_all(
        &mut self,
        locals: &[usize],
        types: &[Type],
        src: Option<&Source>,
        f: impl FnOnce(&mut Self) -> Result<()>,
    ) -> Result<()> {
        match (locals.split_first(), types.split_first()) {
            (Some((l, ls)), Some((t, ts))) => {
                self.bind(*l, t, src, |cx| cx.bind_all(ls, ts, src, f))
            }
            _ => f(self),
        }
    }

    fn node(&mut self, node: &Node, parent: Option<&Source>, depth: usize) -> Result<()> {
        let p = self.p;
        let c = &p.components[self.ci];
        *self.nodes += 1;
        // Text nodes carry no source; diagnostics use the enclosing element.
        let src = node.source().or(parent);
        if depth > MAX_DEPTH || *self.nodes > MAX_NODES {
            return err(
                "E_RESOURCE",
                "Template is too deep or has too many nodes",
                src,
            );
        }
        let mut s = self.scope();
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
                if self.stack.contains(&"svg") && !parts.iter().all(is_whitespace_text) {
                    return err(
                        "E_SVG",
                        "Text inside <svg> is unsupported (only whitespace between elements)",
                        src,
                    );
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
                self.nodes(then, src, depth)?;
                self.nodes(otherwise, src, depth)?;
            }
            Node::Slot {
                name,
                args,
                fallback,
                ..
            } => {
                if self.stack.contains(&"svg") {
                    return err("E_SVG", "Slots inside <svg> are unsupported", src);
                }
                let Some(decl) = c.slot(name) else {
                    return err("E_IR", format!("{} declares no slot {name}", c.name), src);
                };
                let types = &c.slots[decl].params;
                if args.len() != types.len() {
                    return err(
                        "E_IR",
                        format!("Slot {name} takes {} arguments", types.len()),
                        src,
                    );
                }
                for (a, t) in args.iter().zip(types) {
                    s.expect(a, t.clone(), 0, src)?;
                }
                self.nodes(fallback, src, depth)?;
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
                let Type::Array(element) = s.infer(items, 0, src)? else {
                    return err("E_IR", "each requires an array", src);
                };
                self.nodes(otherwise, src, depth)?;
                self.bind(*item, &element, src, |cx| {
                    let inner = |cx: &mut Self| -> Result<()> {
                        if let Some(k) = key {
                            match cx.scope().infer(k, 0, src)? {
                                Type::Fn(_) | Type::Void => {
                                    return err("E_IR", "List keys must be values", src);
                                }
                                _ => {}
                            }
                        }
                        cx.nodes(body, src, depth)
                    };
                    match index {
                        Some(i) => cx.bind(*i, &Type::Number, src, inner),
                        None => inner(cx),
                    }
                })?;
            }
            Node::Component {
                component,
                props,
                slots,
                ..
            } => {
                if self.stack.contains(&"svg") {
                    return err("E_SVG", "Components inside <svg> are unsupported", src);
                }
                let child = &p.components[*component];
                let mut given = HashSet::new();
                for def in slots {
                    let Some(decl) = child.slot(&def.name) else {
                        return err(
                            "E_IR",
                            format!("{} has no slot {}", child.name, def.name),
                            src,
                        );
                    };
                    if !given.insert(def.name.as_str()) {
                        return err("E_IR", format!("Slot {} is given twice", def.name), src);
                    }
                    let types = &child.slots[decl].params;
                    if types.len() != def.params.len() {
                        return err(
                            "E_IR",
                            format!("Slot {} takes {} parameters", def.name, types.len()),
                            src,
                        );
                    }
                    self.bind_all(&def.params, types, src, |cx| {
                        cx.nodes(&def.body, src, depth)
                    })?;
                }
                let mut names = HashSet::new();
                for a in props {
                    let Some(cell) = child.prop(&a.name) else {
                        return err(
                            "E_IR",
                            format!("{} has no prop {}", child.name, a.name),
                            src,
                        );
                    };
                    if !names.insert(a.name.as_str()) {
                        return err("E_IR", format!("Prop {} is passed twice", a.name), src);
                    }
                    let ty = &child.cells[cell].ty;
                    s.expect(&a.value, ty.clone(), 0, src)?;
                    if let Some(b) = &a.bind {
                        let want = Type::Fn(FnType {
                            params: vec![ty.clone()],
                            result: Box::new(Type::Void),
                        });
                        s.expect(b, want, 0, src)?;
                    }
                }
            }
            Node::Element {
                tag,
                attrs,
                props,
                listeners,
                children,
                reference,
                spread,
                classes,
                style_text,
                styles,
                style_update,
                restore,
                ..
            } => {
                let text = |t: &Type| *t == Type::String || *t == Type::maybe(Type::String);
                for e in style_text.iter().chain(styles.iter().map(|a| &a.value)) {
                    if !text(&s.infer(e, 0, src)?) {
                        return err(
                            "E_IR",
                            "Style values must be strings or nullable strings",
                            src,
                        );
                    }
                }
                if (style_text.is_some() || !styles.is_empty())
                    && attrs.iter().any(|a| a.name == "style")
                {
                    return err(
                        "E_IR",
                        "A managed inline style excludes a style attribute",
                        src,
                    );
                }
                for t in classes {
                    if s.infer(&t.value, 0, src)? != Type::Boolean {
                        return err(
                            "E_IR",
                            format!("Class toggle {} must be boolean", t.name),
                            src,
                        );
                    }
                }
                if restore.is_some()
                    && (!props.iter().any(|p| p.name == "value")
                        || !c.effects.iter().any(|e| e.render))
                {
                    return err(
                        "E_IR",
                        "Restoring live values at re-renders needs a value property and a render effect",
                        src,
                    );
                }
                if *style_update == StyleUpdate::Replace {
                    // A text or properties, not both; property names the
                    // CSSOM knows (custom properties included).
                    if style_text.is_some() == !styles.is_empty() {
                        return err(
                            "E_IR",
                            "A replaced inline style has a style text or style properties",
                            src,
                        );
                    }
                    for p in styles {
                        if !runic_css::is_property(&p.name) {
                            return err("E_IR", format!("Unknown style property {}", p.name), src);
                        }
                    }
                }
                if !classes.is_empty() {
                    if let Some(a) = attrs.iter().find(|a| a.name == "class") {
                        if s.infer(&a.value, 0, src)? != Type::String {
                            return err("E_IR", "With class toggles, class must be a string", src);
                        }
                    }
                }
                if let Some(e) = spread {
                    if s.infer(e, 0, src)? != Type::Attrs {
                        return err("E_IR", "A spread must be an attribute bag", src);
                    }
                }
                if let Some(r) = reference {
                    let want = Type::maybe(Type::Element);
                    match c.cells.get(*r) {
                        Some(cell) if cell.ty == want => {}
                        _ => {
                            return err(
                                "E_IR",
                                "An element ref needs a cell of type element | null | undefined",
                                src,
                            );
                        }
                    }
                }
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
                if tag == "button" && self.stack.contains(&"button") {
                    return err("E_IR", "Nested buttons are invalid", src);
                }
                check_svg(
                    tag,
                    self.stack,
                    attrs,
                    listeners,
                    (
                        reference.is_some(),
                        spread.is_some(),
                        style_text.is_some() || !styles.is_empty(),
                    ),
                    src,
                )?;
                let svg = SVG_TAGS.contains(&tag);
                let mut names = HashSet::new();
                for a in attrs {
                    let name_ok = attr_name_ok(&a.name) || (svg && a.name == "viewBox");
                    if !name_ok || !names.insert(a.name.as_str()) {
                        return err(
                            "E_IR",
                            format!("Invalid or duplicate attribute {}", a.name),
                            src,
                        );
                    }
                    let ty = s.infer(&a.value, 0, src)?;
                    if tag == "svg" && a.name == "viewBox" && ty != Type::String {
                        return err("E_SVG", "The viewBox of an <svg> must be a string", src);
                    }
                    match ty {
                        Type::String => {}
                        // SVG attributes are values, never presence flags.
                        Type::Boolean if !svg => {}
                        Type::Maybe(inner) if *inner == Type::String => {}
                        other => {
                            return err(
                                "E_IR",
                                format!("Attribute {} cannot be {}", a.name, other.name()),
                                src,
                            );
                        }
                    }
                }
                // Checkboxes have a live `checked` property and `change`
                // events; other inputs a live `value` and `input` events.
                let checkbox = tag == "input"
                    && attrs.iter().any(|a| {
                        a.name == "type"
                            && matches!(&a.value, Expr::Lit { value: Value::String(t) } if t == "checkbox" || t == "radio")
                    });
                for prop in props {
                    let want = match (prop.name.as_str(), tag, checkbox) {
                        ("value", "input", false)
                        | ("value", "textarea" | "select", _)
                        | ("defaultValue", "textarea", _)
                        | ("selectValue", "select", _) => Type::String,
                        ("checked", "input", true) => Type::Boolean,
                        _ => {
                            return err(
                                "E_IR",
                                "Live properties are value (text inputs, text areas, selects), checked (checkboxes, radio buttons), defaultValue (text areas) and selectValue (selects)",
                                src,
                            );
                        }
                    };
                    if s.infer(&prop.value, 0, src)? != want {
                        return err(
                            "E_IR",
                            format!("The {} property must be {}", prop.name, want.name()),
                            src,
                        );
                    }
                }
                if checkbox && !props.iter().any(|p| p.name == "checked") {
                    return err("E_IR", "Checkboxes need a live checked property", src);
                }
                // The text content follows a controlled value (React DOM);
                // alone it would also be the live value until edited.
                if props.iter().any(|p| p.name == "defaultValue")
                    && !props.iter().any(|p| p.name == "value")
                {
                    return err(
                        "E_IR",
                        "A text area's defaultValue needs a live value property",
                        src,
                    );
                }
                if props.iter().any(|p| p.name == "selectValue")
                    && (props.iter().any(|p| p.name == "value") || restore.is_some())
                {
                    return err(
                        "E_IR",
                        "A select has either a value or a selectValue (without restore)",
                        src,
                    );
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
                    if l.event.window_only() {
                        return err(
                            "E_IR",
                            "popstate and hashchange are fired at the window only",
                            src,
                        );
                    }
                    if l.event == EventKind::Input
                        && !((tag == "input" && !checkbox) || tag == "textarea" || tag == "select")
                    {
                        return err("E_IR", "Input listeners require a text input", src);
                    }
                    if l.event == EventKind::Resize {
                        return err("E_IR", "Resize listeners belong to the window", src);
                    }
                    if l.event == EventKind::Change && !checkbox && tag != "select" {
                        return err(
                            "E_IR",
                            "Change listeners require a checkbox or a select",
                            src,
                        );
                    }
                    if l.args.len() != h.params.len() {
                        return err(
                            "E_IR",
                            "Listener arguments do not match the handler parameters",
                            src,
                        );
                    }
                    for (a, param) in l.args.iter().zip(&h.params) {
                        s.expect(a, param.ty.clone(), 0, src)?;
                    }
                    self.used[l.handler] = true;
                }
                self.stack.push(tag);
                self.nodes(children, src, depth)?;
                self.stack.pop();
            }
        }
        Ok(())
    }
}

// Untracked template reads ---------------------------------------------------
//
// Native templates update a binding when what it reads changed. The
// frameworks re-render a whole block or component when any of its reactive
// state changes, so a value that changes without notifying them shows its new
// value only when a neighbour changes. Templates must not read such values:
// cells that are not reactive but written, reference values tracked by
// identity but mutated in place (raw state, React state mutated against the
// Rules of React), maps and sets in proxied state (proxies do not wrap them)
// and mutated module objects.

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Root {
    Cell(usize, usize),
    Global(usize),
    /// A host service (console, clipboard, history and location,
    /// randomness): its values change without notifying the framework.
    Host(&'static str),
}

/// The host service a built-in uses, if any.
fn host_service(name: &str) -> Option<&'static str> {
    match name.split_once('.')?.0 {
        "console" => Some("The console"),
        "clipboard" => Some("The clipboard"),
        "history" | "location" => Some("The session history (history, location)"),
        "random" => Some("Randomness (Math.random, crypto.randomUUID)"),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Origin {
    Root(Root),
    /// A new value (its own contents may still alias others).
    Fresh,
    Unknown,
}

#[derive(Default)]
struct Mutations {
    /// Non-reactive cells written outside their initialiser.
    written: HashSet<(usize, usize)>,
    /// Values mutated in place, by root.
    roots: HashSet<Root>,
    /// Maps and sets mutated in place, by root.
    collections: HashSet<Root>,
    /// Types of values mutated in place whose root is unknown.
    types: Vec<Type>,
    /// RegExps whose `lastIndex` may change, by root, and whether one of
    /// unknown root may.
    regexps: HashSet<Root>,
    regexp_unknown: bool,
    /// Dates whose time value a setter changes, by root, and whether one of
    /// unknown root does.
    dates: HashSet<Root>,
    date_unknown: bool,
}

/// The RegExp whose `lastIndex` a built-in may change (global and sticky
/// expressions in exec, test, replace and match; setting it).
fn regexp_written<'e>(name: &str, args: &'e [Expr]) -> Option<&'e Expr> {
    match name {
        "regexp.exec" | "regexp.test" | "regexp.set-lastIndex" => args.first(),
        "string.regexp-replace" | "string.regexp-replaceAll" | "string.regexp-match" => args.get(1),
        _ => None,
    }
}

/// A RegExp literal without the g and y flags, whose `lastIndex` built-ins
/// never change.
fn stateless_regexp(init: &Expr) -> bool {
    matches!(
        init,
        Expr::Builtin { name, args, .. } if name == "regexp.new"
            && matches!(args.get(1), Some(Expr::Lit { value: Value::String(f) }) if !f.contains('g') && !f.contains('y'))
    )
}

/// Whether a statement of `body` writes cell `cell`.
fn writes_cell(body: &[Stmt], cell: usize) -> bool {
    body.iter().any(|s| match s {
        Stmt::Set { cell: c, .. } => *c == cell,
        Stmt::Assign {
            target: Place::Cell { cell: c },
            ..
        } => *c == cell,
        Stmt::If {
            then, otherwise, ..
        } => writes_cell(then, cell) || writes_cell(otherwise, cell),
        Stmt::While { body, update, .. } => writes_cell(body, cell) || writes_cell(update, cell),
        Stmt::ForOf { body, .. } => writes_cell(body, cell),
        Stmt::Try {
            body,
            catch,
            finally,
        } => {
            writes_cell(body, cell)
                || catch.as_ref().is_some_and(|c| writes_cell(&c.body, cell))
                || finally.as_ref().is_some_and(|f| writes_cell(f, cell))
        }
        _ => false,
    })
}

/// Whether `root` always holds one RegExp literal without g and y: a
/// module constant, or a cell initialised so and never written.
fn stateless_regexp_root(p: &Program, root: Root) -> bool {
    match root {
        Root::Host(_) => false,
        Root::Global(g) => stateless_regexp(&p.globals[g].init),
        Root::Cell(k, c) => {
            let comp = &p.components[k];
            comp.cells[c].prop.is_none()
                && stateless_regexp(&comp.cells[c].init)
                && !p
                    .functions
                    .iter()
                    .filter(|f| f.component == Some(k))
                    .any(|f| writes_cell(&f.body, c))
                && !comp.handlers.iter().any(|h| writes_cell(&h.body, c))
        }
    }
}

/// The Date a setter changes.
fn date_written<'e>(name: &str, args: &'e [Expr]) -> Option<&'e Expr> {
    if name.starts_with("date.set") {
        args.first()
    } else {
        None
    }
}

fn note_date_write(out: &mut Mutations, origin: Origin) {
    match origin {
        Origin::Root(r) => {
            out.dates.insert(r);
        }
        Origin::Fresh => {}
        Origin::Unknown => out.date_unknown = true,
    }
}

/// Records a RegExp built-in that may change `lastIndex` of `receiver`
/// (with its origin).
fn note_regexp_write(p: &Program, out: &mut Mutations, origin: Origin) {
    match origin {
        Origin::Root(r) if stateless_regexp_root(p, r) => {}
        Origin::Root(r) => {
            out.regexps.insert(r);
        }
        Origin::Fresh => {}
        Origin::Unknown => out.regexp_unknown = true,
    }
}

const MUTATORS: &[&str] = &[
    "array.push",
    "array.pop",
    "array.shift",
    "array.unshift",
    "array.splice",
    "array.sort",
    "array.reverse",
    "array.fill",
    "array.copyWithin",
    "map.set",
    "map.delete",
    "map.clear",
    "set.add",
    "set.delete",
    "set.clear",
];
/// Built-ins returning a new top-level value.
const FRESH: &[&str] = &[
    "array.map",
    "array.filter",
    "array.slice",
    "array.concat",
    "array.flat",
    "array.flatMap",
    "array.toSorted",
    "array.toReversed",
    "array.toSpliced",
    "array.with",
    "Array.from",
    "Object.keys",
    "Object.values",
    "Object.entries",
    "map.keys",
    "map.values",
    "map.entries",
    "set.values",
    "Map.new",
    "Set.new",
    "structuredClone",
    "JSON.parse",
    "string.split",
    "regexp.new",
    "date.new",
];
/// Built-ins returning an element of their receiver.
const ELEMENT: &[&str] = &[
    "array.find",
    "array.findLast",
    "array.at",
    "array.pop",
    "array.shift",
    "map.get",
];

struct Origins<'a> {
    p: &'a Program,
    scope: Scope<'a>,
    locals: Vec<Origin>,
    out: &'a mut Mutations,
    /// The statement being walked (for diagnostics).
    source: Option<Source>,
    /// An in-place mutation of a read-only cell.
    error: Option<Diagnostic>,
}

impl Origins<'_> {
    fn origin(&self, e: &Expr) -> Origin {
        let element = |o: Origin| match o {
            Origin::Root(r) => Origin::Root(r),
            _ => Origin::Unknown,
        };
        match e {
            Expr::Cell { cell, .. } => match self.scope.component {
                Some(k) => Origin::Root(Root::Cell(k, *cell)),
                None => Origin::Unknown,
            },
            Expr::Global { global } => Origin::Root(Root::Global(*global)),
            Expr::Local { local } => self.locals.get(*local).copied().unwrap_or(Origin::Unknown),
            Expr::Get { object, .. } => element(self.origin(object)),
            Expr::Index { array, .. } => element(self.origin(array)),
            Expr::Unwrap { value } | Expr::Some { value } => self.origin(value),
            Expr::Array { .. } | Expr::Record { .. } | Expr::Closure { .. } => Origin::Fresh,
            Expr::Builtin { name, args, .. } if FRESH.contains(&name.as_str()) => {
                let _ = args;
                Origin::Fresh
            }
            Expr::Builtin { name, args, .. } if ELEMENT.contains(&name.as_str()) => {
                element(args.first().map_or(Origin::Unknown, |a| self.origin(a)))
            }
            Expr::Lit { .. } | Expr::Undefined { .. } | Expr::Null { .. } => Origin::Fresh,
            _ => Origin::Unknown,
        }
    }

    fn mutated(&mut self, e: &Expr, collection: bool) {
        match self.origin(e) {
            Origin::Root(Root::Cell(k, cell)) if self.p.components[k].cells[cell].readonly => {
                let c = &self.p.components[k].cells[cell];
                let what = if c.prop.is_some() { "a prop" } else { "state" };
                self.error.get_or_insert(Diagnostic::new(
                    "E_READONLY",
                    format!(
                        "{} is {what} and must not be mutated in place; create a new value and set it",
                        c.name
                    ),
                    self.source.as_ref().or(c.source.as_ref()),
                ));
            }
            Origin::Root(r) => {
                self.out.roots.insert(r);
                if collection {
                    self.out.collections.insert(r);
                }
            }
            Origin::Fresh => {}
            Origin::Unknown => {
                if let Ok(t) = self.scope.infer(e, 0, None) {
                    self.out.types.push(t);
                }
            }
        }
    }

    fn expr(&mut self, e: &Expr) {
        if let Expr::Builtin { name, args, .. } = e {
            if let Some(re) = regexp_written(name, args) {
                let o = self.origin(re);
                note_regexp_write(self.p, self.out, o);
            }
            if let Some(d) = date_written(name, args) {
                let o = self.origin(d);
                note_date_write(self.out, o);
            }
            if MUTATORS.contains(&name.as_str()) {
                if let Some(receiver) = args.first() {
                    self.mutated(
                        receiver,
                        name.starts_with("map.") || name.starts_with("set."),
                    );
                }
            }
        }
        if let Expr::With { local, value, .. } | Expr::Optional { local, value, .. } = e {
            let o = self.origin(value);
            self.bind(*local, o);
        }
        for c in e.children() {
            self.expr(c);
        }
    }

    fn bind(&mut self, local: usize, o: Origin) {
        if self.locals.len() <= local {
            self.locals.resize(local + 1, Origin::Unknown);
        }
        // Several sources: unknown.
        self.locals[local] = match self.locals[local] {
            Origin::Unknown => o,
            prev if prev == o => o,
            _ => Origin::Unknown,
        };
    }

    fn block(&mut self, body: &[Stmt]) {
        for s in body {
            self.stmt(s);
        }
    }

    fn stmt(&mut self, s: &Stmt) {
        if let Some(src) = stmt_source(s) {
            self.source = Some(src.clone());
        }
        match s {
            Stmt::Set { cell, value, .. } => {
                self.expr(value);
                self.written(*cell);
            }
            Stmt::Let { local, value, .. } => {
                if let Some(v) = value {
                    self.expr(v);
                    let o = self.origin(v);
                    self.bind(*local, o);
                }
            }
            Stmt::Assign { target, value, .. } => {
                self.expr(value);
                match target {
                    Place::Local { local } => {
                        let o = self.origin(value);
                        self.bind(*local, o);
                    }
                    Place::Cell { cell } => self.written(*cell),
                    Place::Field { object, .. } => {
                        self.expr(object);
                        self.mutated(object, false);
                    }
                    Place::Index { array, index } => {
                        self.expr(array);
                        self.expr(index);
                        self.mutated(array, false);
                    }
                }
            }
            Stmt::Expr { value, .. } | Stmt::Throw { value, .. } => self.expr(value),
            Stmt::Return { value, .. } => {
                if let Some(v) = value {
                    self.expr(v);
                }
            }
            Stmt::If {
                test,
                then,
                otherwise,
                ..
            } => {
                self.expr(test);
                self.block(then);
                self.block(otherwise);
            }
            Stmt::While {
                test, body, update, ..
            } => {
                self.expr(test);
                self.block(body);
                self.block(update);
            }
            Stmt::ForOf {
                local,
                iterable,
                body,
                ..
            } => {
                self.expr(iterable);
                let o = match self.origin(iterable) {
                    Origin::Root(r) => Origin::Root(r),
                    _ => Origin::Unknown,
                };
                self.bind(*local, o);
                self.block(body);
            }
            Stmt::Try {
                body,
                catch,
                finally,
            } => {
                self.block(body);
                if let Some(c) = catch {
                    self.block(&c.body);
                }
                if let Some(f) = finally {
                    self.block(f);
                }
            }
            Stmt::Break { .. } | Stmt::Continue { .. } => {}
        }
    }

    fn written(&mut self, cell: usize) {
        if let Some(k) = self.scope.component {
            if self.p.components[k].cells[cell].tracking == Tracking::None {
                self.out.written.insert((k, cell));
            }
        }
    }
}

/// The class records a value of type `t` can hold (itself included).
fn class_records(p: &Program, t: &Type, seen: &mut HashSet<usize>, out: &mut Vec<usize>) {
    match t {
        Type::Maybe(t) | Type::Array(t) | Type::Set(t) | Type::Promise(t) => {
            class_records(p, t, seen, out)
        }
        Type::Map(k, v) => {
            class_records(p, k, seen, out);
            class_records(p, v, seen, out);
        }
        Type::Record(r) if seen.insert(*r) => {
            if p.records[*r].class {
                out.push(*r);
            }
            for f in &p.records[*r].fields {
                class_records(p, &f.ty, seen, out);
            }
        }
        _ => {}
    }
}

/// Whether a value of type `outer` can hold a value of type `inner`.
fn holds(p: &Program, outer: &Type, inner: &Type, seen: &mut HashSet<usize>) -> bool {
    if outer == inner {
        return true;
    }
    match outer {
        Type::Maybe(t) | Type::Array(t) | Type::Set(t) | Type::Promise(t) => {
            holds(p, t, inner, seen)
        }
        Type::Map(k, v) => holds(p, k, inner, seen) || holds(p, v, inner, seen),
        Type::Record(r) => {
            seen.insert(*r)
                && p.records[*r]
                    .fields
                    .iter()
                    .any(|f| holds(p, &f.ty, inner, seen))
        }
        _ => false,
    }
}

fn stmt_source(s: &Stmt) -> Option<&Source> {
    match s {
        Stmt::Set { source, .. }
        | Stmt::Let { source, .. }
        | Stmt::Assign { source, .. }
        | Stmt::Expr { source, .. }
        | Stmt::If { source, .. }
        | Stmt::ForOf { source, .. }
        | Stmt::Return { source, .. }
        | Stmt::Throw { source, .. } => source.as_ref(),
        _ => None,
    }
}

fn untracked_template_reads(p: &Program) -> Result<()> {
    let mut m = Mutations::default();
    for f in &p.functions {
        let mut scope = Scope::new(p, f.component);
        scope.locals = f
            .captures
            .iter()
            .chain(&f.params)
            .chain(&f.locals)
            .cloned()
            .collect();
        let mut o = Origins {
            p,
            scope,
            locals: vec![],
            out: &mut m,
            source: f.source.clone(),
            error: None,
        };
        o.block(&f.body);
        if let Some(d) = o.error {
            return Err(d);
        }
    }
    for (k, c) in p.components.iter().enumerate() {
        for h in &c.handlers {
            let mut scope = Scope::new(p, Some(k));
            scope.locals = h.params.iter().chain(&h.locals).cloned().collect();
            scope.payload = h.event.payload();
            let mut o = Origins {
                p,
                scope,
                locals: vec![],
                out: &mut m,
                source: h.source.clone(),
                error: None,
            };
            o.block(&h.body);
            if let Some(d) = o.error {
                return Err(d);
            }
        }
    }
    // RegExps whose lastIndex changes in template expressions themselves.
    for (k, c) in p.components.iter().enumerate() {
        let mut exprs = vec![];
        template_exprs(&c.template, &mut exprs);
        let (mut found, mut dates) = (vec![], vec![]);
        for e in exprs {
            template_regexp_writes(k, e, &mut found);
            template_date_writes(k, e, &mut dates);
        }
        for o in found {
            note_regexp_write(p, &mut m, o);
        }
        for o in dates {
            note_date_write(&mut m, o);
        }
    }
    let changes = |root: Root| -> Option<String> {
        let (ty, name, tracking) = match root {
            Root::Host(what) => {
                return Some(format!(
                    "{what} is used while rendering; the frameworks do not render again when it changes (keep the value in state, set by the code that changes it or by a popstate or hashchange listener)"
                ));
            }
            Root::Cell(k, cell) => {
                let c = &p.components[k].cells[cell];
                (&c.ty, c.name.clone(), c.tracking)
            }
            Root::Global(g) => (
                &p.globals[g].ty,
                p.globals[g].name.clone(),
                Tracking::Identity,
            ),
        };
        if (m.date_unknown || m.dates.contains(&root))
            && holds(p, ty, &Type::Date, &mut HashSet::new())
        {
            return Some(format!(
                "{name} holds a Date that is changed in place (a setter such as setDate or setHours) and is read while rendering; no framework tracks a Date's time value, so the view would depend on how often it renders (assign a new Date instead)"
            ));
        }
        if (m.regexp_unknown || m.regexps.contains(&root))
            && holds(p, ty, &Type::Regexp, &mut HashSet::new())
        {
            return Some(format!(
                "{name} holds a RegExp whose lastIndex changes (exec, test, replace or match with a global or sticky RegExp, or setting lastIndex) and is read while rendering; no framework tracks lastIndex, so the view would depend on how often it renders"
            ));
        }
        let mutated_type = |collections: bool| {
            m.types.iter().any(|t| {
                (!collections || matches!(t, Type::Map(..) | Type::Set(_)))
                    && t.is_reference()
                    && holds(p, ty, t, &mut HashSet::new())
            })
        };
        match tracking {
            Tracking::None if matches!(root, Root::Cell(..)) => {
                let Root::Cell(k, cell) = root else { unreachable!() };
                if m.written.contains(&(k, cell)) {
                    return Some(format!(
                        "{name} changes but is not reactive state; declare it as state (the frameworks would show its new value only when other state changes)"
                    ));
                }
                (ty.is_reference() && (m.roots.contains(&root) || mutated_type(false))).then(|| {
                    format!("{name} is mutated in place but is not reactive state; declare it as state")
                })
            }
            Tracking::None | Tracking::Identity => (ty.is_reference()
                && (m.roots.contains(&root) || mutated_type(false)))
            .then(|| match root {
                Root::Global(_) => format!(
                    "Module value {name} is mutated and read while rendering; module state is not reactive (keep it in component state)"
                ),
                Root::Cell(..) | Root::Host(_) => format!(
                    "{name} is mutated in place, which does not update the view (Svelte: use $state, not $state.raw; React: set a new value instead of mutating state)"
                ),
            }),
            Tracking::Proxied => {
                // Svelte proxies plain objects and arrays only: a class
                // instance in state, and everything it holds, stays raw.
                let mut classes = vec![];
                class_records(p, ty, &mut HashSet::new(), &mut classes);
                let class_mutated = (!classes.is_empty() && m.roots.contains(&root))
                    || classes.iter().any(|&r| {
                        m.types.iter().any(|t| {
                            t.is_reference() && holds(p, &Type::Record(r), t, &mut HashSet::new())
                        })
                    });
                if class_mutated {
                    return Some(format!(
                        "{name} holds a class instance that is mutated in place; Svelte's $state proxies only plain objects and arrays, so the change does not update the view (reactive class fields are M6 stage B; or assign a new instance)"
                    ));
                }
                (m.collections.contains(&root) || mutated_type(true)).then(|| {
                    format!(
                        "{name} holds a Map or Set that is mutated; Svelte state does not track Map and Set mutations (SvelteMap and SvelteSet are planned for M6; or assign a new Map/Set)"
                    )
                })
            }
            Tracking::Deep => None,
        }
    };
    for (k, c) in p.components.iter().enumerate() {
        let mut err = None;
        visit_template(p, k, &c.template, None, &mut |root, src| {
            if err.is_none() {
                if let Some(msg) = changes(root) {
                    err = Some(Diagnostic::new("E_REACTIVITY", msg, src));
                }
            }
        });
        if let Some(d) = err {
            return Err(d);
        }
    }
    Ok(())
}

/// The expressions of a template (without the functions they call).
fn template_exprs<'a>(nodes: &'a [Node], out: &mut Vec<&'a Expr>) {
    for n in nodes {
        match n {
            Node::Element {
                attrs,
                props,
                children,
                spread,
                classes,
                style_text,
                styles,
                ..
            } => {
                out.extend(
                    attrs
                        .iter()
                        .chain(props)
                        .chain(classes)
                        .chain(styles)
                        .map(|a| &a.value),
                );
                out.extend(spread);
                out.extend(style_text);
                template_exprs(children, out);
            }
            Node::Text { parts, .. } => out.extend(parts),
            Node::If {
                test,
                then,
                otherwise,
                ..
            } => {
                out.push(test);
                template_exprs(then, out);
                template_exprs(otherwise, out);
            }
            Node::Component { props, slots, .. } => {
                out.extend(props.iter().map(|a| &a.value));
                for s in slots {
                    template_exprs(&s.body, out);
                }
            }
            Node::Slot { args, fallback, .. } => {
                out.extend(args);
                template_exprs(fallback, out);
            }
            Node::Each {
                items,
                key,
                body,
                otherwise,
                ..
            } => {
                out.push(items);
                out.extend(key.as_ref());
                template_exprs(body, out);
                template_exprs(otherwise, out);
            }
        }
    }
}

/// The origins of RegExps whose lastIndex a template expression of
/// component `k` may change.
fn template_regexp_writes(k: usize, e: &Expr, out: &mut Vec<Origin>) {
    if let Expr::Builtin { name, args, .. } = e {
        if let Some(re) = regexp_written(name, args) {
            out.push(match re {
                Expr::Cell { cell, .. } => Origin::Root(Root::Cell(k, *cell)),
                Expr::Global { global } => Origin::Root(Root::Global(*global)),
                Expr::Builtin { name, .. } if name == "regexp.new" => Origin::Fresh,
                _ => Origin::Unknown,
            });
        }
    }
    for c in e.children() {
        template_regexp_writes(k, c, out);
    }
}

/// The origins of Dates that a template expression of component `k` changes.
fn template_date_writes(k: usize, e: &Expr, out: &mut Vec<Origin>) {
    if let Expr::Builtin { name, args, .. } = e {
        if let Some(d) = date_written(name, args) {
            out.push(match d {
                Expr::Cell { cell, .. } => Origin::Root(Root::Cell(k, *cell)),
                Expr::Global { global } => Origin::Root(Root::Global(*global)),
                Expr::Builtin { name, .. } if name == "date.new" => Origin::Fresh,
                _ => Origin::Unknown,
            });
        }
    }
    for c in e.children() {
        template_date_writes(k, c, out);
    }
}

/// The roots read while rendering `nodes` of component `k` (through the
/// functions they call), with the source of the reading node.
fn visit_template(
    p: &Program,
    k: usize,
    nodes: &[Node],
    parent: Option<&Source>,
    f: &mut dyn FnMut(Root, Option<&Source>),
) {
    for n in nodes {
        let src = match n {
            Node::Element { source, .. }
            | Node::Text { source, .. }
            | Node::If { source, .. }
            | Node::Component { source, .. }
            | Node::Slot { source, .. }
            | Node::Each { source, .. } => source.as_ref().or(parent),
        };
        let mut exprs: Vec<&Expr> = vec![];
        match n {
            Node::Element {
                attrs,
                props,
                children,
                spread,
                classes,
                style_text,
                styles,
                ..
            } => {
                exprs.extend(
                    attrs
                        .iter()
                        .chain(props)
                        .chain(classes)
                        .chain(styles)
                        .map(|a| &a.value),
                );
                exprs.extend(spread);
                exprs.extend(style_text);
                visit_template(p, k, children, src, f);
            }
            Node::Text { parts, .. } => exprs.extend(parts),
            Node::If {
                test,
                then,
                otherwise,
                ..
            } => {
                exprs.push(test);
                visit_template(p, k, then, src, f);
                visit_template(p, k, otherwise, src, f);
            }
            Node::Component { props, slots, .. } => {
                exprs.extend(props.iter().map(|a| &a.value));
                for s in slots {
                    visit_template(p, k, &s.body, src, f);
                }
            }
            Node::Slot { args, fallback, .. } => {
                exprs.extend(args);
                visit_template(p, k, fallback, src, f);
            }
            Node::Each {
                items,
                key,
                body,
                otherwise,
                ..
            } => {
                exprs.push(items);
                exprs.extend(key.as_ref());
                visit_template(p, k, body, src, f);
                visit_template(p, k, otherwise, src, f);
            }
        }
        let mut seen = HashSet::new();
        for e in exprs {
            reads(p, Some(k), e, &mut seen, &mut |r| f(r, src));
        }
    }
}

/// Cells and globals `e` reads, through called functions.
fn reads(
    p: &Program,
    k: Option<usize>,
    e: &Expr,
    seen: &mut HashSet<usize>,
    f: &mut dyn FnMut(Root),
) {
    match e {
        Expr::Cell { cell, .. } => {
            if let Some(k) = k {
                f(Root::Cell(k, *cell));
            }
        }
        Expr::Global { global } => f(Root::Global(*global)),
        Expr::Builtin { name, .. } => {
            if let Some(what) = host_service(name) {
                f(Root::Host(what));
            }
        }
        // A derived value is cached on its tracked dependencies, natively as
        // in the frameworks: what its getter reads otherwise does not show.
        Expr::Call { function, .. } if p.functions[*function].derived => {}
        Expr::Call { function, .. } => {
            if seen.insert(*function) {
                let func = &p.functions[*function];
                let mut body_exprs = vec![];
                collect_exprs(&func.body, &mut body_exprs);
                for x in body_exprs {
                    reads(p, func.component, x, seen, f);
                }
            }
        }
        _ => {}
    }
    for c in e.children() {
        reads(p, k, c, seen, f);
    }
}

fn collect_exprs<'a>(body: &'a [Stmt], out: &mut Vec<&'a Expr>) {
    for s in body {
        match s {
            Stmt::Set { value, .. } | Stmt::Expr { value, .. } | Stmt::Throw { value, .. } => {
                out.push(value)
            }
            Stmt::Let { value, .. } | Stmt::Return { value, .. } => out.extend(value.as_ref()),
            Stmt::Assign { value, .. } => out.push(value),
            Stmt::If {
                test,
                then,
                otherwise,
                ..
            } => {
                out.push(test);
                collect_exprs(then, out);
                collect_exprs(otherwise, out);
            }
            Stmt::While {
                test, body, update, ..
            } => {
                out.push(test);
                collect_exprs(body, out);
                collect_exprs(update, out);
            }
            Stmt::ForOf { iterable, body, .. } => {
                out.push(iterable);
                collect_exprs(body, out);
            }
            Stmt::Try {
                body,
                catch,
                finally,
            } => {
                collect_exprs(body, out);
                if let Some(c) = catch {
                    collect_exprs(&c.body, out);
                }
                if let Some(f) = finally {
                    collect_exprs(f, out);
                }
            }
            Stmt::Break { .. } | Stmt::Continue { .. } => {}
        }
    }
}
