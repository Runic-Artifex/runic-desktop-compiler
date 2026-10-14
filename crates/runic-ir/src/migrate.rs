//! Explicit migration of older IR to schema 5: schema 2/3 (emitted by the old
//! JS adapters) and schema 4.
//!
//! Schema 3 handler updates read `state` (the committed snapshot at handler
//! entry) and `previous` (the pending value of the update's target slot). They
//! map to `cell` reads with `snapshot` and `current` modes respectively.
//!
//! Schema 4 kept the embedded fonts in `styles.assets`; schema 5 moves them,
//! unchanged and in order, to the top-level `assets` list and adds an empty
//! `images` table.

use crate::*;
use serde_json::Value as Json;

fn bad<T>(message: &str) -> Result<T> {
    Err(Diagnostic::new(
        "E_IR",
        format!("Invalid schema 3 IR: {message}"),
        None,
    ))
}

fn field<'a>(v: &'a Json, key: &str) -> Result<&'a Json> {
    v.get(key)
        .map_or_else(|| bad(&format!("missing {key}")), Ok)
}

fn source(v: &Json) -> Option<Source> {
    serde_json::from_value(v.get("source")?.clone()).ok()
}

fn value(v: &Json) -> Result<Value> {
    serde_json::from_value(v.clone()).or_else(|_| bad("literal value"))
}

/// Context for converting expressions: inside a handler update (with the
/// update's target slot) or in a template/initialiser.
#[derive(Clone, Copy)]
enum Scope {
    Template,
    Update { target: usize },
}

fn expr(v: &Json, scope: Scope) -> Result<Expr> {
    let op = field(v, "op")?.as_str().unwrap_or_default();
    let sub = |key: &str| -> Result<Box<Expr>> { Ok(Box::new(expr(field(v, key)?, scope)?)) };
    let arg = |i: usize| -> Result<Box<Expr>> {
        let args = field(v, "args")?
            .as_array()
            .map_or_else(|| bad("args"), Ok)?;
        Ok(Box::new(expr(
            args.get(i).map_or_else(|| bad("argument"), Ok)?,
            scope,
        )?))
    };
    let slot = || -> Result<usize> {
        field(v, "slot")?
            .as_u64()
            .map(|s| s as usize)
            .map_or_else(|| bad("slot"), Ok)
    };
    Ok(match op {
        "literal" => Expr::Lit {
            value: value(field(v, "value")?)?,
        },
        "state" => Expr::Cell {
            cell: slot()?,
            read: match scope {
                Scope::Template => Read::Current,
                Scope::Update { .. } => Read::Snapshot,
            },
        },
        "previous" => match scope {
            Scope::Update { target } => Expr::Cell {
                cell: target,
                read: Read::Current,
            },
            Scope::Template => return bad("previous outside an update"),
        },
        "payload" => Expr::Payload,
        "utf16-length" => Expr::Utf16Length { arg: sub("arg")? },
        "boolean-text" => Expr::ToString { arg: sub("arg")? },
        "not" => Expr::Not { arg: sub("arg")? },
        "neg" => Expr::Neg { arg: sub("arg")? },
        "select" => Expr::Cond {
            test: sub("test")?,
            then: sub("yes")?,
            otherwise: sub("no")?,
        },
        "and" => Expr::And {
            left: sub("left")?,
            right: sub("right")?,
        },
        "or" => Expr::Or {
            left: sub("left")?,
            right: sub("right")?,
        },
        "add" => Expr::Add {
            left: sub("left")?,
            right: sub("right")?,
        },
        "sub" => Expr::Sub {
            left: sub("left")?,
            right: sub("right")?,
        },
        "mul" => Expr::Mul {
            left: sub("left")?,
            right: sub("right")?,
        },
        "eq" => Expr::Eq {
            left: sub("left")?,
            right: sub("right")?,
        },
        "ne" => Expr::Ne {
            left: sub("left")?,
            right: sub("right")?,
        },
        "lt" => Expr::Lt {
            left: sub("left")?,
            right: sub("right")?,
        },
        "le" => Expr::Le {
            left: sub("left")?,
            right: sub("right")?,
        },
        "gt" => Expr::Gt {
            left: sub("left")?,
            right: sub("right")?,
        },
        "ge" => Expr::Ge {
            left: sub("left")?,
            right: sub("right")?,
        },
        "min" => Expr::Min {
            left: arg(0)?,
            right: arg(1)?,
        },
        "max" => Expr::Max {
            left: arg(0)?,
            right: arg(1)?,
        },
        "mapping" => {
            let requirements = field(v, "requirements")?
                .as_array()
                .map_or_else(|| bad("requirements"), Ok)?;
            let mut guard = Expr::lit(Value::Boolean(true));
            for (i, r) in requirements.iter().enumerate() {
                let r = expr(r, scope)?;
                guard = if i == 0 {
                    r
                } else {
                    Expr::And {
                        left: Box::new(guard),
                        right: Box::new(r),
                    }
                };
            }
            Expr::Mapped {
                rule: field(v, "rule")?
                    .as_str()
                    .map_or_else(|| bad("rule"), Ok)?
                    .to_owned(),
                guard: Box::new(guard),
                fast: sub("value")?,
                reference: sub("reference")?,
            }
        }
        other => return bad(&format!("unknown operation {other}")),
    })
}

fn ty(v: &Json) -> Result<Type> {
    serde_json::from_value(v.clone()).or_else(|_| bad("type"))
}

fn node(v: &Json, handlers: &[Json]) -> Result<Node> {
    let children = |v: &Json| -> Result<Vec<Node>> {
        field(v, "children")?
            .as_array()
            .map_or_else(|| bad("children"), Ok)?
            .iter()
            .map(|c| node(c, handlers))
            .collect()
    };
    match field(v, "kind")?.as_str() {
        Some("text") => {
            let parts = field(v, "parts")?
                .as_array()
                .map_or_else(|| bad("parts"), Ok)?;
            let parts = parts
                .iter()
                .map(|p| {
                    let e = expr(p, Scope::Template)?;
                    Ok(match p.get("type").and_then(Json::as_str) {
                        Some("string") => e,
                        Some("number") => Expr::ToString { arg: Box::new(e) },
                        // React renders booleans in children as nothing.
                        Some("boolean") => Expr::string(""),
                        _ => return bad("text part type"),
                    })
                })
                .collect::<Result<_>>()?;
            Ok(Node::Text {
                parts,
                source: source(v),
            })
        }
        Some("conditional") => Ok(Node::If {
            test: expr(field(v, "test")?, Scope::Template)?,
            then: children(v)?,
            otherwise: vec![],
            source: source(v),
        }),
        Some("element") => {
            let mut attrs = vec![];
            let mut props = vec![];
            let object = field(v, "attrs")?
                .as_object()
                .map_or_else(|| bad("attrs"), Ok)?;
            for (name, e) in object {
                let value = expr(e, Scope::Template)?;
                let value = match e.get("type").and_then(Json::as_str) {
                    Some("number") => Expr::ToString {
                        arg: Box::new(value),
                    },
                    _ => value,
                };
                let attr = Attr {
                    name: name.clone(),
                    value,
                };
                if name == "value" {
                    props.push(attr)
                } else {
                    attrs.push(attr)
                }
            }
            let mut listeners = vec![];
            if let Some(event) = v.get("event").and_then(Json::as_u64) {
                let h = handlers
                    .get(event as usize)
                    .map_or_else(|| bad("event"), Ok)?;
                let event_kind = match h.get("kind").and_then(Json::as_str) {
                    Some("text-input") => EventKind::Input,
                    _ => EventKind::Click,
                };
                listeners.push(Listener {
                    event: event_kind,
                    handler: event as usize,
                    args: vec![],
                });
            }
            Ok(Node::Element {
                tag: field(v, "tag")?
                    .as_str()
                    .map_or_else(|| bad("tag"), Ok)?
                    .to_owned(),
                attrs,
                props,
                listeners,
                custom_listeners: vec![],
                reference: None,
                spread: None,
                spread_boolean_text: false,
                classes: vec![],
                style_text: None,
                styles: vec![],
                style_update: StyleUpdate::Compose,
                restore: None,
                adopt: None,
                children: children(v)?,
                source: source(v),
            })
        }
        _ => bad("node kind"),
    }
}

pub fn from_schema3(v: &Json) -> Result<Program> {
    let schema = field(v, "schema")?.as_u64();
    let states = field(v, "states")?
        .as_array()
        .map_or_else(|| bad("states"), Ok)?;
    let handlers = field(v, "handlers")?
        .as_array()
        .map_or_else(|| bad("handlers"), Ok)?;
    let cells = states
        .iter()
        .map(|s| {
            let domain = match s.get("domain") {
                Some(d) if d.get("kind").and_then(Json::as_str) == Some("text") => {
                    Some(Domain::Text {
                        max_utf16: field(d, "maxUtf16")?
                            .as_u64()
                            .map_or_else(|| bad("maxUtf16"), Ok)?
                            as usize,
                    })
                }
                _ => None,
            };
            Ok(Cell {
                readonly: false,
                undefined_default: false,
                tracking: Tracking::Identity,
                name: field(s, "name")?.as_str().unwrap_or_default().to_owned(),
                ty: ty(field(s, "type")?)?,
                init: Expr::Lit {
                    value: value(field(s, "initial")?)?,
                },
                domain,
                prop: None,
                source: source(s),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let converted_handlers = handlers
        .iter()
        .map(|h| {
            let event = match (schema, h.get("kind").and_then(Json::as_str)) {
                (Some(3), Some("text-input")) => EventKind::Input,
                (Some(3), Some("click")) | (Some(2), _) => EventKind::Click,
                _ => return bad("handler kind"),
            };
            let updates = field(h, "updates")?
                .as_array()
                .map_or_else(|| bad("updates"), Ok)?;
            let body = updates
                .iter()
                .map(|u| {
                    let target =
                        field(u, "slot")?.as_u64().map_or_else(|| bad("slot"), Ok)? as usize;
                    Ok(Stmt::Set {
                        cell: target,
                        value: expr(field(u, "value")?, Scope::Update { target })?,
                        source: source(u),
                    })
                })
                .collect::<Result<_>>()?;
            Ok(Handler {
                params: vec![],
                locals: vec![],
                name: None,
                event,
                body,
                source: source(h),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let template = vec![node(field(v, "ui")?, handlers)?];
    let frontend = match schema {
        Some(2) => {
            let f = field(v, "frontend")?;
            serde_json::json!({
                "adapter": "react", "version": 1,
                "packages": { "react": f.get("react") },
                "tools": { "vite": f.get("vite"), "typescript": f.get("typescript") },
            })
        }
        _ => field(v, "frontend")?.clone(),
    };
    let mappings =
        serde_json::from_value(field(v, "mappings")?.clone()).or_else(|_| bad("mappings"))?;
    let capabilities = field(v, "capabilities")?
        .as_array()
        .map_or_else(|| bad("capabilities"), Ok)?
        .iter()
        .filter_map(Json::as_str)
        .filter(|c| *c != "finite-state")
        .map(str::to_owned)
        .collect();
    Ok(Program {
        fragments: vec![],
        document: Default::default(),
        body: Default::default(),
        container: None,
        records: vec![],
        functions: vec![],
        schema: SCHEMA,
        meta: Meta {
            title: field(v, "title")?.as_str().unwrap_or_default().to_owned(),
            source_hash: field(v, "sourceHash")?
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            frontend,
            provenance: v.get("provenance").cloned().unwrap_or(Json::Null),
            mappings,
        },
        renderer: match v.get("renderer").and_then(Json::as_str) {
            None | Some("cpu") => Renderer::Cpu,
            Some("gpu") => Renderer::Gpu,
            Some(_) => return bad("renderer"),
        },
        capabilities,
        styles: Styles {
            css: field(v, "css")?.as_str().unwrap_or_default().to_owned(),
            guards: vec![],
        },
        assets: serde_json::from_value(field(v, "assets")?.clone()).or_else(|_| bad("assets"))?,
        images: vec![],
        globals: vec![],
        restore_focus: false,
        schedule: Default::default(),
        components: vec![Component {
            name: "App".into(),
            cells,
            handlers: converted_handlers,
            template,
            template_locals: vec![],
            slots: vec![],
            effects: vec![],
            mounts: vec![],
        }],
        root: 0,
        container_attrs: match v.get("container").and_then(|c| c.get("attrs")) {
            Some(a) => serde_json::from_value(a.clone()).or_else(|_| bad("container attrs"))?,
            None => Default::default(),
        },
    })
}

/// Schema 4 differs from schema 5 only in where the embedded assets are
/// listed: `styles.assets` moves to the top-level `assets` list unchanged, and
/// the `images` table is empty.
pub fn from_schema4(mut v: Json) -> Result<Program> {
    let bad =
        |message: &str| Diagnostic::new("E_IR", format!("Invalid schema 4 IR: {message}"), None);
    let object = v.as_object_mut().ok_or_else(|| bad("not an object"))?;
    for key in ["assets", "images"] {
        if object.contains_key(key) {
            return Err(bad(&format!("unknown field `{key}`")));
        }
    }
    let assets = object
        .get_mut("styles")
        .and_then(Json::as_object_mut)
        .ok_or_else(|| bad("missing styles"))?
        .remove("assets")
        .unwrap_or_else(|| Json::Array(vec![]));
    object.insert("assets".into(), assets);
    object.insert("images".into(), Json::Array(vec![]));
    object.insert("schema".into(), Json::from(SCHEMA));
    serde_json::from_value(v).map_err(|e| bad(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema4(styles: Json) -> Json {
        json!({
            "schema": 4,
            "meta": {"title": "t", "sourceHash": "0".repeat(64), "frontend": {}},
            "capabilities": ["dom"],
            "styles": styles,
            "components": [{"name": "App", "template": [], "cells": [], "handlers": []}],
            "root": 0
        })
    }

    #[test]
    fn schema4_fonts_move_to_assets_unchanged() {
        let fonts = json!([
            {"path": "assets/A.woff2", "sha256": "a".repeat(64), "bytes": 1234, "mime": "font/woff2"},
            {"path": "vendor/B.woff2", "sha256": "b".repeat(64), "bytes": 4 << 20, "mime": "font/woff2"}
        ]);
        let css = "@font-face { font-family: F; src: url(data:font/woff2;base64,AAEC); }";
        let raw = schema4(
            json!({"css": css, "assets": fonts.clone(), "guards": [{"selector": "p", "message": "m"}]}),
        );
        let program = crate::load(&raw.to_string()).unwrap();
        assert_eq!(program.schema, SCHEMA);
        assert_eq!(serde_json::to_value(&program.assets).unwrap(), fonts);
        assert!(program.images.is_empty());
        assert_eq!(program.styles.css, css);
        assert_eq!(program.styles.guards.len(), 1);
        // Everything else is the schema 4 program as it was.
        let mut expected = raw.clone();
        expected["schema"] = json!(SCHEMA);
        expected["styles"].as_object_mut().unwrap().remove("assets");
        expected["assets"] = fonts;
        expected["images"] = json!([]);
        let direct: Program = serde_json::from_value(expected).unwrap();
        assert_eq!(program, direct);
        // A program without fonts migrates to empty lists.
        let program = crate::load(&schema4(json!({"css": ""})).to_string()).unwrap();
        assert!(program.assets.is_empty() && program.images.is_empty());
    }

    #[test]
    fn schema4_rejects_schema5_fields() {
        for key in ["assets", "images"] {
            let mut raw = schema4(json!({"css": ""}));
            raw[key] = json!([]);
            let e = crate::load(&raw.to_string()).unwrap_err();
            assert_eq!(e.code, "E_IR");
            assert!(e.message.contains(key), "{e}");
        }
    }

    #[test]
    fn schema5_rejects_styles_assets() {
        let mut raw = schema4(json!({"css": "", "assets": []}));
        raw["schema"] = json!(5);
        assert_eq!(crate::load(&raw.to_string()).unwrap_err().code, "E_IR");
    }
}
