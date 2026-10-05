//! `@floating-ui/core` 1.7.3's `computePosition` as `@floating-ui/dom` 1.7.4
//! drives it, against the real packages in Node (tests/vectors/floating.mjs →
//! tests/vectors/floating.json). Each vector is replayed with a fake platform
//! that answers every call from the recorded trace, while a simulated
//! microtask counter advances on every `Step::Tick`. Asserted: the identical
//! trace (call, tick and arguments, including the state custom middleware and
//! `apply` receive), the outcome (exact numbers, `middlewareData` key
//! presence, or the rejection) and the tick of the promise's `.then`.

use runic_js::floating::*;
use runic_js::{JsResult, Throw, number_to_string};
use serde_json::{Map, Value, json};

type E = String;
type D = Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/floating.json")).expect("floating vectors")
}

/// The generator's number encoding: safe integers as numbers, everything else
/// as `String(v)` (and "-0"). `null` (an answer missing after a divergence)
/// is NaN.
fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().expect("number"),
        Value::String(s) => match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            s => s.parse().unwrap_or_else(|_| panic!("number {s:?}")),
        },
        Value::Null => f64::NAN,
        _ => panic!("number expected, got {v}"),
    }
}

fn enc(x: f64) -> Value {
    if x == 0.0 && x.is_sign_negative() {
        "-0".into()
    } else if x.is_finite() && x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0 {
        json!(x as i64)
    } else {
        Value::String(number_to_string(x))
    }
}

fn opt_num(o: &Value, key: &str) -> Option<f64> {
    o.get(key).filter(|v| !v.is_null()).map(num)
}

fn opt_bool(o: &Value, key: &str, default: bool) -> bool {
    o.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn placement(v: &Value) -> Placement {
    Placement::parse(v.as_str().expect("placement")).expect("known placement")
}

fn rect(v: &Value) -> Rect {
    Rect {
        x: num(&v["x"]),
        y: num(&v["y"]),
        width: num(&v["width"]),
        height: num(&v["height"]),
    }
}

fn rect_json(r: &Rect) -> Value {
    json!({ "x": enc(r.x), "y": enc(r.y), "width": enc(r.width), "height": enc(r.height) })
}

fn sides_json(s: &SideObject) -> Value {
    json!({ "top": enc(s.top), "right": enc(s.right), "bottom": enc(s.bottom), "left": enc(s.left) })
}

fn offset_parent_json(p: &OffsetParent<E>) -> Value {
    match p {
        OffsetParent::Element(e) => json!(e),
        OffsetParent::Window => json!("window"),
    }
}

// ---------------------------------------------------------------------------
// Inputs.

fn padding(v: Option<&Value>) -> Padding {
    match v {
        None | Some(Value::Null) => Padding::All(0.0),
        Some(v @ (Value::Number(_) | Value::String(_))) => Padding::All(num(v)),
        Some(o) => Padding::Sides {
            top: opt_num(o, "top"),
            right: opt_num(o, "right"),
            bottom: opt_num(o, "bottom"),
            left: opt_num(o, "left"),
        },
    }
}

fn detect(o: &Value) -> DetectOverflowOptions<E> {
    DetectOverflowOptions {
        boundary: match o.get("boundary") {
            None => Boundary::ClippingAncestors,
            Some(Value::String(s)) if s == "clippingAncestors" => Boundary::ClippingAncestors,
            Some(Value::Array(ids)) => Boundary::Elements(
                ids.iter()
                    .map(|id| id.as_str().expect("element id").to_string())
                    .collect(),
            ),
            Some(v) => panic!("boundary {v}"),
        },
        root_boundary: match o.get("rootBoundary") {
            None => RootBoundary::Viewport,
            Some(Value::String(s)) if s == "viewport" => RootBoundary::Viewport,
            Some(Value::String(s)) if s == "document" => RootBoundary::Document,
            Some(r) => RootBoundary::Rect(rect(r)),
        },
        element_context: match o.get("elementContext").and_then(Value::as_str) {
            Some("reference") => ElementContext::Reference,
            _ => ElementContext::Floating,
        },
        alt_boundary: opt_bool(o, "altBoundary", false),
        padding: padding(o.get("padding")),
    }
}

fn middleware(v: &Value) -> Middleware<E> {
    let (kind, o) = v
        .as_object()
        .expect("middleware")
        .iter()
        .next()
        .expect("kind");
    match kind.as_str() {
        "offset" => Middleware::Offset(match o {
            Value::Null => OffsetOptions::default(),
            Value::Number(_) | Value::String(_) => OffsetOptions::Value(num(o)),
            _ => OffsetOptions::Axes {
                main_axis: opt_num(o, "mainAxis"),
                cross_axis: opt_num(o, "crossAxis"),
                alignment_axis: opt_num(o, "alignmentAxis"),
            },
        }),
        "shift" => Middleware::Shift(ShiftOptions {
            main_axis: opt_bool(o, "mainAxis", true),
            cross_axis: opt_bool(o, "crossAxis", false),
            limiter: match o.get("limiter") {
                None | Some(Value::Null) => None,
                Some(l) => Some(LimitShiftOptions {
                    offset: match l.get("offset") {
                        None => LimitShiftOffset::Value(0.0),
                        Some(v @ (Value::Number(_) | Value::String(_))) => {
                            LimitShiftOffset::Value(num(v))
                        }
                        Some(v) => LimitShiftOffset::Axes {
                            main_axis: opt_num(v, "mainAxis"),
                            cross_axis: opt_num(v, "crossAxis"),
                        },
                    },
                    main_axis: opt_bool(l, "mainAxis", true),
                    cross_axis: opt_bool(l, "crossAxis", true),
                }),
            },
            overflow: detect(o),
        }),
        "flip" => Middleware::Flip(FlipOptions {
            main_axis: opt_bool(o, "mainAxis", true),
            cross_axis: match o.get("crossAxis") {
                None | Some(Value::Bool(true)) => FlipCrossAxis::True,
                Some(Value::Bool(false)) => FlipCrossAxis::False,
                Some(Value::String(s)) if s == "alignment" => FlipCrossAxis::Alignment,
                Some(v) => panic!("flip crossAxis {v}"),
            },
            fallback_placements: o
                .get("fallbackPlacements")
                .map(|l| l.as_array().expect("list").iter().map(placement).collect()),
            fallback_strategy: match o.get("fallbackStrategy").and_then(Value::as_str) {
                Some("initialPlacement") => FallbackStrategy::InitialPlacement,
                _ => FallbackStrategy::BestFit,
            },
            fallback_axis_side_direction: match o
                .get("fallbackAxisSideDirection")
                .and_then(Value::as_str)
            {
                Some("start") => FallbackAxisSideDirection::Start,
                Some("end") => FallbackAxisSideDirection::End,
                _ => FallbackAxisSideDirection::None,
            },
            flip_alignment: opt_bool(o, "flipAlignment", true),
            overflow: detect(o),
        }),
        "size" => Middleware::Size(SizeOptions {
            apply: o
                .get("apply")
                .map(|a| a["id"].as_u64().expect("apply id") as usize),
            overflow: detect(o),
        }),
        "arrow" => Middleware::Arrow(ArrowOptions {
            element: o["element"].as_str().map(str::to_string),
            padding: padding(o.get("padding")),
        }),
        "hide" => Middleware::Hide(HideOptions {
            strategy: match o.get("strategy").and_then(Value::as_str) {
                Some("escaped") => HideStrategy::Escaped,
                _ => HideStrategy::ReferenceHidden,
            },
            overflow: detect(o),
        }),
        "custom" => Middleware::Custom {
            name: o["name"].as_str().expect("name").to_string(),
            id: o["id"].as_u64().expect("id") as usize,
        },
        other => panic!("middleware {other}"),
    }
}

// ---------------------------------------------------------------------------
// Outputs.

fn middleware_data_json(md: &MiddlewareData<D>) -> Value {
    let mut m = Map::new();
    if let Some(o) = &md.offset {
        m.insert(
            "offset".into(),
            json!({ "x": enc(o.x), "y": enc(o.y), "placement": o.placement.as_str() }),
        );
    }
    if let Some(s) = &md.shift {
        m.insert(
            "shift".into(),
            json!({ "x": enc(s.x), "y": enc(s.y), "enabled": { "x": s.enabled.x, "y": s.enabled.y } }),
        );
    }
    if let Some(f) = &md.flip {
        let mut o = Map::new();
        if let Some(i) = f.index {
            o.insert("index".into(), json!(i));
        }
        if let Some(list) = &f.overflows {
            let list: Vec<Value> = list
                .iter()
                .map(|d| {
                    json!({
                        "placement": d.placement.as_str(),
                        "overflows": d.overflows.iter().map(|&v| enc(v)).collect::<Vec<_>>(),
                    })
                })
                .collect();
            o.insert("overflows".into(), Value::Array(list));
        }
        m.insert("flip".into(), Value::Object(o));
    }
    if md.size.is_some() {
        m.insert("size".into(), json!({}));
    }
    if let Some(a) = &md.arrow {
        let mut o = Map::new();
        for (k, v) in [
            ("x", a.x),
            ("y", a.y),
            ("centerOffset", a.center_offset),
            ("alignmentOffset", a.alignment_offset),
        ] {
            if let Some(v) = v {
                o.insert(k.into(), enc(v));
            }
        }
        m.insert("arrow".into(), Value::Object(o));
    }
    if let Some(h) = &md.hide {
        let mut o = Map::new();
        if let Some(s) = &h.reference_hidden_offsets {
            o.insert("referenceHiddenOffsets".into(), sides_json(s));
        }
        if let Some(b) = h.reference_hidden {
            o.insert("referenceHidden".into(), json!(b));
        }
        if let Some(s) = &h.escaped_offsets {
            o.insert("escapedOffsets".into(), sides_json(s));
        }
        if let Some(b) = h.escaped {
            o.insert("escaped".into(), json!(b));
        }
        m.insert("hide".into(), Value::Object(o));
    }
    for (name, d) in &md.custom {
        m.insert(name.clone(), d.clone());
    }
    Value::Object(m)
}

fn state_json(s: &MiddlewareState<E, D>) -> Value {
    json!({
        "x": enc(s.x),
        "y": enc(s.y),
        "initialPlacement": s.initial_placement.as_str(),
        "placement": s.placement.as_str(),
        "strategy": s.strategy.as_str(),
        "rects": { "reference": rect_json(&s.rects.reference), "floating": rect_json(&s.rects.floating) },
        "middlewareData": middleware_data_json(s.middleware_data),
        "elements": [s.reference, s.floating],
    })
}

fn thrown(answer: &Value) -> Option<Throw> {
    answer
        .get("throw")
        .map(|m| Throw::new("Error", m.as_str().expect("message")))
}

fn reset(v: Option<&Value>) -> Option<Reset> {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => None,
        Some(Value::Bool(true)) => Some(Reset::True),
        Some(o) => Some(Reset::Object {
            placement: o.get("placement").map(placement),
            rects: match o.get("rects") {
                None | Some(Value::Null) | Some(Value::Bool(false)) => None,
                Some(Value::Bool(true)) => Some(ResetRects::Recompute),
                Some(r) => Some(ResetRects::Rects(ElementRects {
                    reference: rect(&r["reference"]),
                    floating: rect(&r["floating"]),
                })),
            },
        }),
    }
}

// ---------------------------------------------------------------------------
// The fake platform: answers from the trace, records what it was asked.

struct Fake<'a> {
    expected: &'a [Value],
    cursor: usize,
    tick: u64,
    actual: Vec<Value>,
}

impl Fake<'_> {
    fn answer(&mut self, name: &str, args: Value) -> Value {
        self.actual.push(json!([self.tick, name, args]));
        let answer = match self.expected.get(self.cursor) {
            Some(e) if e[1] == name => e[3].clone(),
            _ => Value::Null,
        };
        self.cursor += 1;
        answer
    }
}

impl Platform<E, D> for Fake<'_> {
    fn is_rtl(&mut self, element: &E) -> bool {
        self.answer("isRTL", json!([element]))
            .as_bool()
            .unwrap_or(false)
    }

    fn get_dimensions(&mut self, element: &E) -> Dimensions {
        let a = self.answer("getDimensions", json!([element]));
        Dimensions {
            width: num(&a["width"]),
            height: num(&a["height"]),
        }
    }

    fn get_offset_parent(&mut self, element: &E) -> OffsetParent<E> {
        match self.answer("getOffsetParent", json!([element])).as_str() {
            Some("window") | None => OffsetParent::Window,
            Some(id) => OffsetParent::Element(id.to_string()),
        }
    }

    fn get_rect_relative_to_offset_parent(
        &mut self,
        element: &E,
        offset_parent: &OffsetParent<E>,
        strategy: Strategy,
    ) -> Rect {
        let args = json!([
            element,
            offset_parent_json(offset_parent),
            strategy.as_str()
        ]);
        rect(&self.answer("getRectRelativeToOffsetParent", args))
    }

    fn get_clipping_rect(
        &mut self,
        element: &E,
        boundary: &Boundary<E>,
        root_boundary: &RootBoundary,
        strategy: Strategy,
    ) -> Rect {
        let boundary = match boundary {
            Boundary::ClippingAncestors => json!("clippingAncestors"),
            Boundary::Elements(list) => json!(list),
        };
        let root = match root_boundary {
            RootBoundary::Viewport => json!("viewport"),
            RootBoundary::Document => json!("document"),
            RootBoundary::Rect(r) => rect_json(r),
        };
        let args = json!([element, boundary, root, strategy.as_str()]);
        rect(&self.answer("getClippingRect", args))
    }

    fn get_scale(&mut self, element: &E) -> Coords {
        let a = self.answer("getScale", json!([element]));
        Coords {
            x: num(&a["x"]),
            y: num(&a["y"]),
        }
    }

    fn convert_offset_parent_relative_rect_to_viewport_relative_rect(
        &mut self,
        reference: &E,
        floating: &E,
        r: Rect,
        offset_parent: &OffsetParent<E>,
        strategy: Strategy,
    ) -> Rect {
        let args = json!([
            reference,
            floating,
            rect_json(&r),
            offset_parent_json(offset_parent),
            strategy.as_str()
        ]);
        rect(&self.answer("convert", args))
    }

    fn client_size(&mut self, target: &OffsetParent<E>, width: bool) -> Option<f64> {
        let prop = if width { "width" } else { "height" };
        let a = self.answer("clientSize", json!([offset_parent_json(target), prop]));
        (!a.is_null()).then(|| num(&a))
    }

    fn call_custom(
        &mut self,
        id: usize,
        state: &MiddlewareState<E, D>,
    ) -> JsResult<MiddlewareReturn<D>> {
        let a = self.answer("custom", json!([id, state_json(state)]));
        if let Some(t) = thrown(&a) {
            return Err(t);
        }
        Ok(MiddlewareReturn {
            x: opt_num(&a, "x"),
            y: opt_num(&a, "y"),
            data: a.get("data").cloned(),
            reset: reset(a.get("reset")),
        })
    }

    fn apply_size(
        &mut self,
        id: usize,
        state: &MiddlewareState<E, D>,
        available_width: f64,
        available_height: f64,
    ) -> JsResult<()> {
        let args = json!([
            id,
            state_json(state),
            enc(available_width),
            enc(available_height)
        ]);
        match thrown(&self.answer("apply", args)) {
            Some(t) => Err(t),
            None => Ok(()),
        }
    }

    fn merge_custom(&mut self, old: Option<&D>, new: Option<&D>) -> D {
        let mut merged = Map::new();
        for d in [old, new].into_iter().flatten() {
            if let Value::Object(o) = d {
                for (k, v) in o {
                    merged.insert(k.clone(), v.clone());
                }
            }
        }
        Value::Object(merged)
    }
}

// ---------------------------------------------------------------------------

#[test]
fn placements_round_trip() {
    for p in Placement::ALL {
        assert_eq!(Placement::parse(p.as_str()), Some(p));
    }
    assert_eq!(Placement::parse("top-center"), None);
}

#[test]
fn compute_position_matches_floating_ui() {
    let v = vectors();
    let list = v["vectors"].as_array().expect("vectors");
    let mut failures = vec![];
    for (i, case) in list.iter().enumerate() {
        let label = format!(
            "#{i} {} {} {}",
            case["category"].as_str().unwrap_or(""),
            case["placement"],
            case["middleware"]
        );
        let initial = if case["placement"].is_null() {
            Placement::parse("bottom").unwrap()
        } else {
            placement(&case["placement"])
        };
        let strategy = match case["strategy"].as_str() {
            Some("fixed") => Strategy::Fixed,
            _ => Strategy::Absolute,
        };
        let list: Vec<Middleware<E>> = case["middleware"]
            .as_array()
            .expect("middleware")
            .iter()
            .map(middleware)
            .collect();
        let expected = case["trace"].as_array().expect("trace");
        let mut fake = Fake {
            expected,
            cursor: 0,
            tick: 0,
            actual: vec![],
        };
        let mut computation: Computation<E, D> = Computation::new(
            "reference".to_string(),
            "floating".to_string(),
            initial,
            strategy,
            list,
        );
        let result = loop {
            match computation.step(&mut fake) {
                Step::Tick => fake.tick += 1,
                Step::Done(r) => break r,
            }
            assert!(fake.tick < 100_000, "{label}: does not settle");
        };
        let then = fake.tick + 1;
        let outcome = match result {
            Ok(p) => json!({
                "then": then,
                "result": {
                    "x": enc(p.x),
                    "y": enc(p.y),
                    "placement": p.placement.as_str(),
                    "strategy": p.strategy.as_str(),
                    "middlewareData": middleware_data_json(&p.middleware_data),
                },
            }),
            Err(e) => json!({
                "then": then,
                "rejected": { "name": e.name.to_rust(), "message": e.message.to_rust() },
            }),
        };

        let want: Vec<Value> = expected.iter().map(|e| json!([e[0], e[1], e[2]])).collect();
        if fake.actual != want {
            let at = fake
                .actual
                .iter()
                .zip(&want)
                .position(|(a, w)| a != w)
                .unwrap_or(fake.actual.len().min(want.len()));
            failures.push(format!(
                "{label}: trace differs at call {at} ({} calls, expected {}):\n  got  {}\n  want {}",
                fake.actual.len(),
                want.len(),
                fake.actual.get(at).unwrap_or(&Value::Null),
                want.get(at).unwrap_or(&Value::Null),
            ));
        } else if outcome != case["outcome"] {
            failures.push(format!(
                "{label}: outcome\n  got  {outcome}\n  want {}",
                case["outcome"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} vectors fail:\n{}",
        failures.len(),
        list.len(),
        failures
            .iter()
            .take(15)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
