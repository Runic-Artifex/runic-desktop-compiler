//! Runic IR schema 4: serialized program types, validation, schema 3 migration
//! and the reference interpreter that defines the meaning of each operation.
//! See `docs/IR.md` and `docs/design/M2-VALUES.md`.

use serde::{Deserialize, Serialize};

pub mod builtins;
pub mod interp;
pub mod migrate;
pub mod validate;

pub const SCHEMA: u32 = 4;

/// A diagnostic with a stable code, mirroring the frontend's `Diagnostic`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
}

impl Diagnostic {
    pub fn new(code: &str, message: impl Into<String>, source: Option<&Source>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            source: source.cloned(),
        }
    }
    /// Attribute a location-less diagnostic to an enclosing construct.
    pub fn or_source(mut self, source: Option<&Source>) -> Self {
        if self.source.is_none() {
            self.source = source.cloned();
        }
        self
    }
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.source {
            Some(s) => write!(
                f,
                "{} {}:{}:{} {}",
                self.code, s.file, s.line, s.column, self.message
            ),
            None => write!(f, "{} {}", self.code, self.message),
        }
    }
}

impl std::error::Error for Diagnostic {}

pub type Result<T> = std::result::Result<T, Diagnostic>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Program {
    pub schema: u32,
    pub meta: Meta,
    #[serde(default)]
    pub renderer: Renderer,
    pub capabilities: Vec<String>,
    pub styles: Styles,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub records: Vec<RecordType>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub functions: Vec<Function>,
    /// Module-level constants, evaluated once in order at startup (a module
    /// object keeps its identity across all components).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub globals: Vec<Global>,
    pub components: Vec<Component>,
    pub root: usize,
    /// Attributes the framework sets on the mount container (`#root`).
    #[serde(
        default,
        rename = "containerAttrs",
        skip_serializing_if = "std::collections::BTreeMap::is_empty"
    )]
    pub container_attrs: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Meta {
    pub title: String,
    pub source_hash: String,
    /// Adapter identity and resolved package/tool versions (provenance only;
    /// the backend never branches on it).
    pub frontend: serde_json::Value,
    #[serde(default)]
    pub provenance: serde_json::Value,
    #[serde(default)]
    pub mappings: Vec<MappingRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MappingRef {
    pub id: String,
    pub version: u32,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Renderer {
    #[default]
    Cpu,
    Gpu,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Styles {
    pub css: String,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asset {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub mime: String,
}

/// IR types (D16). Unit variants serialize as strings (`"number"`), the others
/// as single-key objects (`{"maybe": T}`, `{"map": [K, V]}`).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Type {
    Number,
    String,
    Boolean,
    /// The result type of functions without a value.
    Void,
    Maybe(Box<Type>),
    Array(Box<Type>),
    Record(usize),
    Map(Box<Type>, Box<Type>),
    Set(Box<Type>),
    Fn(FnType),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FnType {
    pub params: Vec<Type>,
    pub result: Box<Type>,
}

impl Type {
    pub fn name(&self) -> String {
        match self {
            Type::Number => "number".into(),
            Type::String => "string".into(),
            Type::Boolean => "boolean".into(),
            Type::Void => "void".into(),
            Type::Maybe(t) => format!("{} | undefined", t.name()),
            Type::Array(t) => format!("{}[]", t.name()),
            Type::Record(r) => format!("record#{r}"),
            Type::Map(k, v) => format!("Map<{}, {}>", k.name(), v.name()),
            Type::Set(t) => format!("Set<{}>", t.name()),
            Type::Fn(f) => format!(
                "({}) => {}",
                f.params
                    .iter()
                    .map(Type::name)
                    .collect::<Vec<_>>()
                    .join(", "),
                f.result.name()
            ),
        }
    }
    pub fn maybe(t: Type) -> Type {
        Type::Maybe(Box::new(t))
    }
    pub fn array(t: Type) -> Type {
        Type::Array(Box::new(t))
    }
    /// Reference types have identity (and are affected by deep mutation).
    pub fn is_reference(&self) -> bool {
        match self {
            Type::Array(_) | Type::Record(_) | Type::Map(..) | Type::Set(_) => true,
            Type::Maybe(t) => t.is_reference(),
            _ => false,
        }
    }
}

/// A literal value. Serialized literals are always finite.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value {
    Boolean(bool),
    Number(f64),
    String(String),
}

impl Value {
    pub fn ty(&self) -> Type {
        match self {
            Value::Boolean(_) => Type::Boolean,
            Value::Number(_) => Type::Number,
            Value::String(_) => Type::String,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordType {
    pub name: String,
    pub fields: Vec<Field>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: Type,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Local {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: Type,
    /// Captured by a closure and mutated: shared by reference.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub boxed: bool,
}

/// A function. Its local index space is `[...captures, ...params, ...locals]`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Function {
    pub name: String,
    /// The component whose cells the function reads and writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub captures: Vec<Local>,
    pub params: Vec<Local>,
    #[serde(default)]
    pub locals: Vec<Local>,
    pub result: Type,
    pub body: Vec<Stmt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
}

impl Function {
    pub fn local(&self, i: usize) -> Option<&Local> {
        self.captures
            .iter()
            .chain(&self.params)
            .chain(&self.locals)
            .nth(i)
    }
    pub fn local_count(&self) -> usize {
        self.captures.len() + self.params.len() + self.locals.len()
    }
}

/// A module constant. `init` may read earlier globals and call module functions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Global {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: Type,
    pub init: Expr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Component {
    pub name: String,
    #[serde(default)]
    pub cells: Vec<Cell>,
    #[serde(default)]
    pub handlers: Vec<Handler>,
    pub template: Vec<Node>,
    /// Locals bound by `each` nodes (and slot parameters) in the template.
    #[serde(
        rename = "templateLocals",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub template_locals: Vec<Local>,
}

impl Component {
    /// Index of the prop cell named `name`.
    pub fn prop(&self, name: &str) -> Option<usize> {
        self.cells
            .iter()
            .position(|c| c.prop.as_deref() == Some(name))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tracking {
    /// Dirty when assigned a value that is not SameValue to the old one.
    #[default]
    Identity,
    /// Also dirty after any heap mutation in a handler (Svelte `$state`, Vue `ref`).
    Deep,
    /// Never dirty: a plain variable whose changes do not update the UI.
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cell {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: Type,
    pub init: Expr,
    #[serde(default, skip_serializing_if = "is_identity")]
    pub tracking: Tracking,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<Domain>,
    /// The prop this cell receives from the parent (`init` is its default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prop: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
}

fn is_identity(t: &Tracking) -> bool {
    *t == Tracking::Identity
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Domain {
    /// Single-line text without control characters, at most `max_utf16` units.
    Text {
        #[serde(rename = "maxUtf16")]
        max_utf16: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EventKind {
    /// Activation: pointer click, or Enter/Space on a focused button.
    Click,
    /// Text control value change; the handler receives the new value as payload.
    Input,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Handler {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub event: EventKind,
    /// Values passed by the listener (`args`); the local index space is
    /// params, then locals.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<Local>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locals: Vec<Local>,
    pub body: Vec<Stmt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "place", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Place {
    Local { local: usize },
    Cell { cell: usize },
    Field { object: Expr, field: usize },
    Index { array: Expr, index: Expr },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Catch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<usize>,
    pub body: Vec<Stmt>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Stmt {
    Set {
        cell: usize,
        value: Expr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    Let {
        local: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Expr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    Assign {
        target: Place,
        value: Expr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    Expr {
        value: Expr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    If {
        test: Expr,
        then: Vec<Stmt>,
        #[serde(rename = "else", default, skip_serializing_if = "Vec::is_empty")]
        otherwise: Vec<Stmt>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    While {
        test: Expr,
        body: Vec<Stmt>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        update: Vec<Stmt>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    ForOf {
        local: usize,
        iterable: Expr,
        body: Vec<Stmt>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    Break {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Continue {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Return {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Expr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    Throw {
        value: Expr,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    Try {
        body: Vec<Stmt>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        catch: Option<Catch>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        finally: Option<Vec<Stmt>>,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Read {
    /// The latest value, including writes earlier in the running handler.
    #[default]
    Current,
    /// The value at handler entry (the value the last render observed).
    Snapshot,
}

/// An array literal item.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ArrayItem {
    Spread { spread: Expr },
    Item(Expr),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Expr {
    Lit {
        value: Value,
    },
    Undefined {
        #[serde(rename = "type")]
        ty: Type,
    },
    Null {
        #[serde(rename = "type")]
        ty: Type,
    },
    /// A module constant.
    Global {
        global: usize,
    },
    Cell {
        cell: usize,
        #[serde(default)]
        read: Read,
    },
    Local {
        local: usize,
    },
    Payload,
    Not {
        arg: Box<Expr>,
    },
    Neg {
        arg: Box<Expr>,
    },
    BitNot {
        arg: Box<Expr>,
    },
    ToString {
        arg: Box<Expr>,
    },
    ToNumber {
        arg: Box<Expr>,
    },
    ToBoolean {
        arg: Box<Expr>,
    },
    Typeof {
        arg: Box<Expr>,
    },
    Utf16Length {
        arg: Box<Expr>,
    },
    Add {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Sub {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Mul {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Div {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Rem {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Pow {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Min {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Max {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    BitAnd {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    BitOr {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    BitXor {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Shl {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Shr {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Ushr {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Concat {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Eq {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Ne {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Lt {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Le {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Gt {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Ge {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    And {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Or {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    /// `left ?? right`
    Nullish {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Cond {
        test: Box<Expr>,
        then: Box<Expr>,
        #[serde(rename = "else")]
        otherwise: Box<Expr>,
    },
    Mapped {
        rule: String,
        guard: Box<Expr>,
        fast: Box<Expr>,
        reference: Box<Expr>,
    },
    Record {
        record: usize,
        fields: Vec<Expr>,
    },
    Array {
        #[serde(rename = "type")]
        ty: Type,
        items: Vec<ArrayItem>,
    },
    Get {
        object: Box<Expr>,
        field: usize,
    },
    Index {
        array: Box<Expr>,
        index: Box<Expr>,
    },
    /// Wrap a value into `Maybe`.
    Some {
        value: Box<Expr>,
    },
    /// `value?.…`: when `value` is nullish the result is undefined; otherwise
    /// the unwrapped value is bound to `local` and `then` (a Maybe) is the result.
    Optional {
        value: Box<Expr>,
        local: usize,
        then: Box<Expr>,
    },
    /// Unwrap a Maybe; throws a TypeError when nullish.
    Unwrap {
        value: Box<Expr>,
    },
    Call {
        function: usize,
        args: Vec<Expr>,
    },
    CallValue {
        callee: Box<Expr>,
        args: Vec<Expr>,
    },
    Closure {
        function: usize,
        captures: Vec<usize>,
    },
    Builtin {
        name: String,
        args: Vec<Expr>,
        #[serde(rename = "type")]
        ty: Type,
    },
    /// Evaluate `value`, bind it to `local`, then evaluate `body`.
    With {
        local: usize,
        value: Box<Expr>,
        body: Box<Expr>,
    },
}

impl Expr {
    pub fn lit(value: Value) -> Expr {
        Expr::Lit { value }
    }
    pub fn string(s: impl Into<String>) -> Expr {
        Expr::Lit {
            value: Value::String(s.into()),
        }
    }

    /// Direct children in evaluation order.
    pub fn children(&self) -> Vec<&Expr> {
        use Expr::*;
        match self {
            Lit { .. }
            | Undefined { .. }
            | Null { .. }
            | Cell { .. }
            | Global { .. }
            | Local { .. }
            | Payload
            | Closure { .. } => vec![],
            Not { arg }
            | Neg { arg }
            | BitNot { arg }
            | ToString { arg }
            | ToNumber { arg }
            | ToBoolean { arg }
            | Typeof { arg }
            | Utf16Length { arg } => vec![arg],
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
            | Ushr { left, right }
            | Concat { left, right }
            | Eq { left, right }
            | Ne { left, right }
            | Lt { left, right }
            | Le { left, right }
            | Gt { left, right }
            | Ge { left, right }
            | And { left, right }
            | Or { left, right }
            | Nullish { left, right } => vec![left, right],
            Cond {
                test,
                then,
                otherwise,
            } => vec![test, then, otherwise],
            Mapped {
                guard,
                fast,
                reference,
                ..
            } => vec![guard, fast, reference],
            Record { fields, .. } => fields.iter().collect(),
            Array { items, .. } => items
                .iter()
                .map(|i| match i {
                    ArrayItem::Spread { spread } => spread,
                    ArrayItem::Item(e) => e,
                })
                .collect(),
            Get { object, .. } => vec![object],
            Index { array, index } => vec![array, index],
            Some { value } | Unwrap { value } => vec![value],
            Optional { value, then, .. } => vec![value, then],
            Call { args, .. } | Builtin { args, .. } => args.iter().collect(),
            CallValue { callee, args } => std::iter::once(&**callee).chain(args).collect(),
            With { value, body, .. } => vec![value, body],
        }
    }

    /// Cells read directly by this expression (not through calls), sorted.
    pub fn deps(&self) -> Vec<usize> {
        let mut out = vec![];
        self.collect_deps(&mut out);
        out.sort_unstable();
        out.dedup();
        out
    }

    fn collect_deps(&self, out: &mut Vec<usize>) {
        if let Expr::Cell { cell, .. } = self {
            out.push(*cell);
        }
        for c in self.children() {
            c.collect_deps(out);
        }
    }

    pub fn reads_snapshot(&self) -> bool {
        matches!(
            self,
            Expr::Cell {
                read: Read::Snapshot,
                ..
            }
        ) || self.children().iter().any(|c| c.reads_snapshot())
    }

    /// Whether evaluation may run user functions (whose reads are not visible in `deps`).
    pub fn calls(&self) -> bool {
        matches!(
            self,
            Expr::Call { .. } | Expr::CallValue { .. } | Expr::Builtin { .. }
        ) || self.children().iter().any(|c| c.calls())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attr {
    pub name: String,
    pub value: Expr,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Listener {
    pub event: EventKind,
    pub handler: usize,
    /// Arguments for the handler's params, evaluated in the template scope at dispatch.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<Expr>,
}

/// A prop passed to a component instance.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PropArg {
    pub name: String,
    pub value: Expr,
    /// `fn(T) -> void` called after the child writes the prop (two-way binding).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind: Option<Expr>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Node {
    Element {
        tag: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attrs: Vec<Attr>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        props: Vec<Attr>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        listeners: Vec<Listener>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        children: Vec<Node>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    Text {
        parts: Vec<Expr>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    If {
        test: Expr,
        then: Vec<Node>,
        #[serde(rename = "else", default, skip_serializing_if = "Vec::is_empty")]
        otherwise: Vec<Node>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    /// An instance of `component`.
    Component {
        component: usize,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        props: Vec<PropArg>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
    /// One block of `body` per element of `items`.
    Each {
        items: Expr,
        /// Template local receiving the element.
        item: usize,
        /// Template local receiving the index.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
        /// Block identity; blocks are matched by index without a key.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<Expr>,
        body: Vec<Node>,
        #[serde(rename = "else", default, skip_serializing_if = "Vec::is_empty")]
        otherwise: Vec<Node>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Source>,
    },
}

impl Node {
    pub fn source(&self) -> Option<&Source> {
        match self {
            Node::Element { source, .. }
            | Node::Text { source, .. }
            | Node::If { source, .. }
            | Node::Component { source, .. }
            | Node::Each { source, .. } => source.as_ref(),
        }
    }
    /// The literal `id` attribute of an element, if any.
    pub fn element_id(&self) -> Option<&str> {
        let Node::Element { attrs, .. } = self else {
            return None;
        };
        attrs
            .iter()
            .find(|a| a.name == "id")
            .and_then(|a| match &a.value {
                Expr::Lit {
                    value: Value::String(s),
                } => Some(s.as_str()),
                _ => None,
            })
    }
}

/// Parse and validate a serialized program of schema 3 or 4. Schema 3 inputs
/// are migrated explicitly.
pub fn load(json: &str) -> Result<Program> {
    let raw: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| Diagnostic::new("E_IR", format!("Invalid IR JSON: {e}"), None))?;
    let program = match raw.get("schema").and_then(|s| s.as_u64()) {
        Some(3) | Some(2) => migrate::from_schema3(&raw)?,
        Some(4) => serde_json::from_value(raw)
            .map_err(|e| Diagnostic::new("E_IR", format!("Invalid schema 4 IR: {e}"), None))?,
        other => {
            return Err(Diagnostic::new(
                "E_IR",
                format!("Unsupported IR schema {other:?}"),
                None,
            ));
        }
    };
    validate::validate(&program)?;
    Ok(program)
}
