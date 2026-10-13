//! `@floating-ui/dom`'s `computePosition` (M6 overlays): the generated
//! app's glue between the pack's records (runic_ir::floating) and
//! runic_js::floating's resumable computation. The platform reads layout
//! through the runtime (`cx.dom.floating_*`) and calls the program's custom
//! middleware and size `apply` closures; every JavaScript `await` of the
//! computation is a microtask of the app.

use crate::expr::rust_str;
use runic_ir::floating::{
    ARROW, CUSTOM, FLIP, FloatingShape, HIDE, OFFSET, SHIFT, SIZE, floating_shape,
};
use runic_ir::{Program, Type};

/// The program's floating shape, if it computes positions.
pub fn shape(p: &Program) -> Option<FloatingShape> {
    let named = |r: usize, names: &[&str]| {
        let f = &p.records[r].fields;
        f.len() == names.len() && f.iter().zip(names).all(|(f, n)| f.name == *n)
    };
    let m = (0..p.records.len()).find(|&r| named(r, &["name", "kind", "options", "fn"]))?;
    let pos = (0..p.records.len())
        .find(|&r| named(r, &["x", "y", "placement", "strategy", "middlewareData"]))?;
    floating_shape(&p.records, m, pos)
}

/// The glue functions (`floating_compute` and its helpers).
pub fn glue(p: &Program, s: &FloatingShape) -> String {
    let FloatingShape {
        middleware: m,
        options: o,
        limiter: l,
        padding_sides: _,
        rect,
        element_rects: er,
        elements: els,
        side_object: so,
        offset_data: od,
        shift_enabled: se,
        shift_data: sd,
        flip_overflow: fo,
        flip_data: fd,
        size_data: zd,
        arrow_data: ad,
        hide_data: hd,
        middleware_data: md,
        custom_data: cd,
        state: st,
        apply_state: ast,
        ret,
        position: pos,
    } = *s;
    // The custom data record (a custom middleware's `data`), also where no
    // custom middleware is named in middlewareData.
    let cd = cd.or(match &p.records[ret].fields[2].ty {
        Type::Maybe(i) => match **i {
            Type::Record(c) => Some(c),
            _ => None,
        },
        _ => None,
    });
    let d = match cd {
        Some(c) => format!("JsRef<R{c}>"),
        None => "()".into(),
    };
    // Custom entries of middlewareData (fields 6…), by name.
    let customs: Vec<(usize, String)> = p.records[md].fields[6..]
        .iter()
        .enumerate()
        .map(|(i, f)| (i + 6, f.name.clone()))
        .collect();
    let custom_fields: String = customs
        .iter()
        .map(|(i, n)| {
            format!(
                "f{i}: match md.custom({}) {{ Some(v) => Maybe::Some(v.clone()), None => Maybe::Undefined }}, ",
                rust_str(n)
            )
        })
        .collect();
    let custom_count = cd.map_or(0, |c| p.records[c].fields.len());
    let merge = match cd {
        Some(c) => {
            let fields: String = (0..custom_count)
                .map(|i| {
                    format!(
                        "f{i}: match new.map(|n| n.peek_settled().f{i}.clone()) {{ Some(Maybe::Some(v)) => Maybe::Some(v), _ => old.map_or(Maybe::Undefined, |o| o.peek_settled().f{i}.clone()) }}, "
                    )
                })
                .collect();
            format!("JsRef::new(R{c} {{ {fields} }})")
        }
        None => "()".into(),
    };
    format!(
        r#"
/// The pack's floating records, as runic_js::floating sees them.
mod floating_glue {{
use super::*;
use js::floating as fl;
pub type FlD = {d};
type CustomFn = Rc<dyn Fn(&mut Cx, JsRef<R{st}>) -> JsResult<JsRef<R{ret}>>>;
type ApplyFn = Rc<dyn Fn(&mut Cx, JsRef<R{ast}>) -> JsResult<()>>;
fn opt(v: &Maybe<f64>) -> Option<f64> {{ match v {{ Maybe::Some(x) => Some(*x), _ => None }} }}
fn opt_b(v: &Maybe<bool>) -> Option<bool> {{ match v {{ Maybe::Some(x) => Some(*x), _ => None }} }}
fn opt_s(v: &Maybe<JsString>) -> Option<String> {{ match v {{ Maybe::Some(x) => Some(x.to_rust()), _ => None }} }}
fn placement(s: &str) -> fl::Placement {{
    fl::Placement::parse(s).unwrap_or_else(|| {{
        runic_runtime::unsupported(&format!("floating-ui placement {{s:?}}"));
        fl::Placement {{ side: fl::Side::Bottom, alignment: None }}
    }})
}}
fn padding(o: &R{o}) -> fl::Padding {{
    match &o.f9 {{
        Maybe::Some(sides) => {{
            let s = sides.peek_settled();
            fl::Padding::Sides {{ top: opt(&s.f0), right: opt(&s.f1), bottom: opt(&s.f2), left: opt(&s.f3) }}
        }}
        _ => fl::Padding::All(opt(&o.f8).unwrap_or(0.0)),
    }}
}}
fn overflow(o: &R{o}) -> fl::DetectOverflowOptions<u64> {{
    fl::DetectOverflowOptions {{
        boundary: match &o.f10 {{
            Maybe::Some(list) => fl::Boundary::Elements(list.peek_settled().iter().map(|e| e.0).collect()),
            _ => fl::Boundary::ClippingAncestors,
        }},
        root_boundary: if opt_s(&o.f11).as_deref() == Some("document") {{ fl::RootBoundary::Document }} else {{ fl::RootBoundary::Viewport }},
        element_context: if opt_s(&o.f12).as_deref() == Some("reference") {{ fl::ElementContext::Reference }} else {{ fl::ElementContext::Floating }},
        alt_boundary: opt_b(&o.f13).unwrap_or(false),
        padding: padding(o),
    }}
}}
fn limiter(l: &R{l}) -> fl::LimitShiftOptions {{
    fl::LimitShiftOptions {{
        offset: match (opt(&l.f0), opt(&l.f1), opt(&l.f2)) {{
            (Some(v), _, _) => fl::LimitShiftOffset::Value(v),
            (None, None, None) => fl::LimitShiftOffset::Value(0.0),
            (None, main, cross) => fl::LimitShiftOffset::Axes {{ main_axis: main, cross_axis: cross }},
        }},
        main_axis: opt_b(&l.f3).unwrap_or(true),
        cross_axis: opt_b(&l.f4).unwrap_or(true),
    }}
}}
fn middleware(list: &JsArray<JsRef<R{m}>>, customs: &mut Vec<CustomFn>, applies: &mut Vec<ApplyFn>) -> Vec<fl::Middleware<u64>> {{
    let mut out = Vec::new();
    for item in list.peek_settled().iter() {{
        let mw = item.peek_settled();
        let o = mw.f2.peek_settled();
        out.push(match mw.f1 as u8 {{
            {OFFSET} => match opt(&o.f0) {{
                Some(v) => fl::Middleware::Offset(fl::OffsetOptions::Value(v)),
                None => fl::Middleware::Offset(fl::OffsetOptions::Axes {{ main_axis: opt(&o.f1), cross_axis: opt(&o.f2), alignment_axis: opt(&o.f3) }}),
            }},
            {SHIFT} => fl::Middleware::Shift(fl::ShiftOptions {{
                main_axis: opt_b(&o.f4).unwrap_or(true),
                cross_axis: opt_b(&o.f5).unwrap_or(false),
                limiter: match &o.f7 {{ Maybe::Some(l) => Some(limiter(&l.peek_settled())), _ => None }},
                overflow: overflow(&o),
            }}),
            {FLIP} => fl::Middleware::Flip(fl::FlipOptions {{
                main_axis: opt_b(&o.f4).unwrap_or(true),
                cross_axis: if opt_b(&o.f6) == Some(true) {{ fl::FlipCrossAxis::Alignment }} else if opt_b(&o.f5).unwrap_or(true) {{ fl::FlipCrossAxis::True }} else {{ fl::FlipCrossAxis::False }},
                fallback_placements: match &o.f14 {{ Maybe::Some(list) => Some(list.peek_settled().iter().map(|s| placement(&s.to_rust())).collect()), _ => None }},
                fallback_strategy: if opt_s(&o.f15).as_deref() == Some("initialPlacement") {{ fl::FallbackStrategy::InitialPlacement }} else {{ fl::FallbackStrategy::BestFit }},
                fallback_axis_side_direction: match opt_s(&o.f16).as_deref() {{ Some("start") => fl::FallbackAxisSideDirection::Start, Some("end") => fl::FallbackAxisSideDirection::End, _ => fl::FallbackAxisSideDirection::None }},
                flip_alignment: opt_b(&o.f17).unwrap_or(true),
                overflow: overflow(&o),
            }}),
            {SIZE} => fl::Middleware::Size(fl::SizeOptions {{
                apply: match &o.f18 {{ Maybe::Some(f) => {{ applies.push(Rc::clone(f)); Some(applies.len() - 1) }} _ => None }},
                overflow: overflow(&o),
            }}),
            {ARROW} => fl::Middleware::Arrow(fl::ArrowOptions {{
                element: match &o.f19 {{ Maybe::Some(e) => Some(e.0), _ => None }},
                padding: padding(&o),
            }}),
            {HIDE} => fl::Middleware::Hide(fl::HideOptions {{
                strategy: if opt_s(&o.f20).as_deref() == Some("escaped") {{ fl::HideStrategy::Escaped }} else {{ fl::HideStrategy::ReferenceHidden }},
                overflow: overflow(&o),
            }}),
            {CUSTOM} => match &mw.f3 {{
                Maybe::Some(f) => {{ customs.push(Rc::clone(f)); fl::Middleware::Custom {{ name: mw.f0.to_rust(), id: customs.len() - 1 }} }}
                _ => fl::Middleware::Custom {{ name: mw.f0.to_rust(), id: usize::MAX }},
            }},
            other => unreachable!("validated middleware kind {{other}}"),
        }});
    }}
    out
}}
fn rect(r: &fl::Rect) -> JsRef<R{rect}> {{ JsRef::new(R{rect} {{ f0: r.x, f1: r.y, f2: r.width, f3: r.height }}) }}
fn side_object(s: &fl::SideObject) -> JsRef<R{so}> {{ JsRef::new(R{so} {{ f0: s.top, f1: s.right, f2: s.bottom, f3: s.left }}) }}
fn some<T>(v: Option<T>) -> Maybe<T> {{ match v {{ Some(x) => Maybe::Some(x), None => Maybe::Undefined }} }}
fn data(md: &fl::MiddlewareData<FlD>) -> JsRef<R{md}> {{
    JsRef::new(R{md} {{
        f0: some(md.offset.map(|o| JsRef::new(R{od} {{ f0: o.x, f1: o.y, f2: JsString::from(o.placement.as_str()) }}))),
        f1: some(md.shift.map(|s| JsRef::new(R{sd} {{ f0: s.x, f1: s.y, f2: JsRef::new(R{se} {{ f0: s.enabled.x, f1: s.enabled.y }}) }}))),
        f2: some(md.flip.as_ref().map(|f| JsRef::new(R{fd} {{
            f0: some(f.index.map(|i| i as f64)),
            f1: some(f.overflows.as_ref().map(|list| js::array(list.iter().map(|o| JsRef::new(R{fo} {{ f0: JsString::from(o.placement.as_str()), f1: js::array(o.overflows.clone()) }})).collect()))),
        }}))),
        f3: some(md.size.map(|_| JsRef::new(R{zd} {{}}))),
        f4: some(md.arrow.map(|a| JsRef::new(R{ad} {{ f0: some(a.x), f1: some(a.y), f2: some(a.center_offset), f3: some(a.alignment_offset) }}))),
        f5: some(md.hide.map(|h| JsRef::new(R{hd} {{ f0: some(h.reference_hidden_offsets.as_ref().map(side_object)), f1: some(h.reference_hidden), f2: some(h.escaped_offsets.as_ref().map(side_object)), f3: some(h.escaped) }}))),
        {custom_fields}
    }})
}}
fn state(s: &fl::MiddlewareState<u64, FlD>) -> R{st} {{
    R{st} {{
        f0: s.x, f1: s.y,
        f2: JsString::from(s.initial_placement.as_str()),
        f3: JsString::from(s.placement.as_str()),
        f4: JsString::from(s.strategy.as_str()),
        f5: data(s.middleware_data),
        f6: JsRef::new(R{er} {{ f0: rect(&s.rects.reference), f1: rect(&s.rects.floating) }}),
        f7: JsRef::new(R{els} {{ f0: js::Element(*s.reference), f1: js::Element(*s.floating) }}),
    }}
}}
struct Host<'a> {{ cx: &'a mut Cx, customs: &'a [CustomFn], applies: &'a [ApplyFn], cache: &'a mut runic_runtime::floating::ClippingCache }}
impl fl::Platform<u64, FlD> for Host<'_> {{
    fn is_rtl(&mut self, e: &u64) -> bool {{ self.cx.dom.floating_is_rtl(*e) }}
    fn get_dimensions(&mut self, e: &u64) -> fl::Dimensions {{ self.cx.dom.floating_dimensions(*e) }}
    fn get_offset_parent(&mut self, e: &u64) -> fl::OffsetParent<u64> {{ self.cx.dom.floating_offset_parent(*e) }}
    fn get_rect_relative_to_offset_parent(&mut self, e: &u64, op: &fl::OffsetParent<u64>, strategy: fl::Strategy) -> fl::Rect {{ self.cx.dom.floating_rect_relative_to_offset_parent(*e, op, strategy) }}
    fn get_clipping_rect(&mut self, e: &u64, boundary: &fl::Boundary<u64>, root: &fl::RootBoundary, strategy: fl::Strategy) -> fl::Rect {{ self.cx.dom.floating_clipping_rect_cached(*e, boundary, root, strategy, self.cache) }}
    fn get_scale(&mut self, e: &u64) -> fl::Coords {{ self.cx.dom.floating_scale(*e) }}
    fn convert_offset_parent_relative_rect_to_viewport_relative_rect(&mut self, _reference: &u64, floating: &u64, r: fl::Rect, op: &fl::OffsetParent<u64>, strategy: fl::Strategy) -> fl::Rect {{ self.cx.dom.floating_convert_rect(*floating, r, op, strategy) }}
    fn client_size(&mut self, target: &fl::OffsetParent<u64>, width: bool) -> Option<f64> {{ self.cx.dom.floating_client_size(target, width) }}
    fn call_custom(&mut self, id: usize, s: &fl::MiddlewareState<u64, FlD>) -> JsResult<fl::MiddlewareReturn<FlD>> {{
        let f = Rc::clone(&self.customs[id]);
        let r = f(self.cx, JsRef::new(state(s)))?;
        let r = r.peek_settled();
        Ok(fl::MiddlewareReturn {{ x: opt(&r.f0), y: opt(&r.f1), data: match &r.f2 {{ Maybe::Some(v) => Some(v.clone()), _ => None }}, reset: None }})
    }}
    fn apply_size(&mut self, id: usize, s: &fl::MiddlewareState<u64, FlD>, w: f64, h: f64) -> JsResult<()> {{
        let f = Rc::clone(&self.applies[id]);
        let base = state(s);
        f(self.cx, JsRef::new(R{ast} {{ f0: base.f0, f1: base.f1, f2: base.f2, f3: base.f3, f4: base.f4, f5: base.f5, f6: base.f6, f7: base.f7, f8: w, f9: h }}))
    }}
    #[allow(unused_variables)]
    fn merge_custom(&mut self, old: Option<&FlD>, new: Option<&FlD>) -> FlD {{ {merge} }}
}}
struct Run {{ comp: fl::Computation<u64, FlD>, customs: Vec<CustomFn>, applies: Vec<ApplyFn>, cache: runic_runtime::floating::ClippingCache, promise: js::JsPromise<JsRef<R{pos}>, Lst> }}
fn step(cx: &mut Cx, run: Rc<RefCell<Run>>) -> JsResult<()> {{
    let outcome = {{
        let mut r = run.borrow_mut();
        let Run {{ comp, customs, applies, cache, .. }} = &mut *r;
        let mut host = Host {{ cx: &mut *cx, customs, applies, cache }};
        comp.step(&mut host)
    }};
    match outcome {{
        fl::Step::Tick => {{
            let again = Rc::clone(&run);
            let job: Lst = Rc::new(move |cx: &mut Cx| step(cx, Rc::clone(&again)));
            runic_runtime::Microtasks::queue_microtask(cx, job);
        }}
        fl::Step::Done(result) => {{
            let promise = run.borrow().promise.clone();
            let value = result.map(|p| JsRef::new(R{pos} {{ f0: p.x, f1: p.y, f2: JsString::from(p.placement.as_str()), f3: JsString::from(p.strategy.as_str()), f4: data(&p.middleware_data) }}));
            runic_runtime::promises::settle(cx, &promise, value);
        }}
    }}
    Ok(())
}}
/// `computePosition(reference, floating, {{ middleware, placement, strategy }})`.
pub fn compute(cx: &mut Cx, reference: js::Element, floating: js::Element, list: JsArray<JsRef<R{m}>>, place: JsString, strategy: JsString) -> js::JsPromise<JsRef<R{pos}>, Lst> {{
    let mut customs = Vec::new();
    let mut applies = Vec::new();
    let list = middleware(&list, &mut customs, &mut applies);
    let strategy = if strategy.to_rust() == "fixed" {{ fl::Strategy::Fixed }} else {{ fl::Strategy::Absolute }};
    let promise = js::JsPromise::pending();
    let run = Rc::new(RefCell::new(Run {{ comp: fl::Computation::new(reference.0, floating.0, placement(&place.to_rust()), strategy, list), customs, applies, cache: Default::default(), promise: promise.clone() }}));
    let _ = step(cx, run);
    promise
}}
}}
"#
    )
}
