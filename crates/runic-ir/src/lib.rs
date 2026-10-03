//! Runic IR schema 4: serialized program types, validation, schema 3 migration
//! and the reference interpreter that defines the meaning of each operation.
//! See `docs/IR.md`.

use serde::{Deserialize, Serialize};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Type {
    Number,
    String,
    Boolean,
}

impl Type {
    pub fn name(self) -> &'static str {
        match self {
            Type::Number => "number",
            Type::String => "string",
            Type::Boolean => "boolean",
        }
    }
}

/// A literal or runtime value. Serialized literals are always finite.
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
    /// SameValue (`Object.is`) semantics, used to detect changed cells.
    pub fn same(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Number(a), Value::Number(b)) => runic_js::same_value(*a, *b),
            (a, b) => a == b,
        }
    }
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cell {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: Type,
    pub init: Expr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<Domain>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
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
    pub body: Vec<Stmt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Expr {
    Lit {
        value: Value,
    },
    Cell {
        cell: usize,
        #[serde(default)]
        read: Read,
    },
    Payload,
    Not {
        arg: Box<Expr>,
    },
    Neg {
        arg: Box<Expr>,
    },
    ToString {
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
    Min {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Max {
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
            Lit { .. } | Cell { .. } | Payload => vec![],
            Not { arg } | Neg { arg } | ToString { arg } | Utf16Length { arg } => vec![arg],
            Add { left, right }
            | Sub { left, right }
            | Mul { left, right }
            | Min { left, right }
            | Max { left, right }
            | Concat { left, right }
            | Eq { left, right }
            | Ne { left, right }
            | Lt { left, right }
            | Le { left, right }
            | Gt { left, right }
            | Ge { left, right }
            | And { left, right }
            | Or { left, right } => vec![left, right],
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
        }
    }

    /// Cells read by this expression (any read mode), sorted and deduplicated.
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
}

impl Node {
    pub fn source(&self) -> Option<&Source> {
        match self {
            Node::Element { source, .. } | Node::Text { source, .. } | Node::If { source, .. } => {
                source.as_ref()
            }
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
