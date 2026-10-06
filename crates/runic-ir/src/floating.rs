//! The records of `@floating-ui/dom`'s pack (M6 overlays,
//! docs/design/M6-OVERLAYS.md): the frontend's pack builds middleware,
//! their options and the results of `floating.compute` as records of these
//! shapes, which the validator recognises by their field names and types
//! and the code generator converts to and from runic_js::floating's types.

use crate::{RecordType, Type};

/// Middleware kinds (the `kind` field of a middleware record).
pub const CUSTOM: u8 = 0;
pub const OFFSET: u8 = 1;
pub const SHIFT: u8 = 2;
pub const FLIP: u8 = 3;
pub const SIZE: u8 = 4;
pub const ARROW: u8 = 5;
pub const HIDE: u8 = 6;

/// The fields of a middleware's options record, in order: offset's number
/// form and axes; shift's and flip's axis checks (`crossAxisAlignment`:
/// flip's `crossAxis: 'alignment'`); shift's limiter; detectOverflow's
/// options; flip's fallbacks; size's `apply`; arrow's element; hide's
/// strategy. Absent options are undefined (the middleware's defaults).
pub const OPTIONS: [&str; 21] = [
    "value",
    "mainAxisOffset",
    "crossAxisOffset",
    "alignmentAxis",
    "mainAxis",
    "crossAxis",
    "crossAxisAlignment",
    "limiter",
    "padding",
    "paddingSides",
    "boundary",
    "rootBoundary",
    "elementContext",
    "altBoundary",
    "fallbackPlacements",
    "fallbackStrategy",
    "fallbackAxisSideDirection",
    "flipAlignment",
    "apply",
    "element",
    "strategy",
];

/// The record indices of a program's floating records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FloatingShape {
    /// `{ name, kind, options, fn }`.
    pub middleware: usize,
    pub options: usize,
    /// `{ offset, mainAxis, crossAxis, offsetMainAxis, offsetCrossAxis }`
    /// (limitShift's options; offsets undefined where absent).
    pub limiter: usize,
    /// `{ top, right, bottom, left }`, each nullable (a partial padding).
    pub padding_sides: usize,
    /// `{ x, y, width, height }`.
    pub rect: usize,
    /// `{ reference, floating }` of rects.
    pub element_rects: usize,
    /// `{ reference, floating }` of elements.
    pub elements: usize,
    /// `{ top, right, bottom, left }`.
    pub side_object: usize,
    pub offset_data: usize,
    pub shift_enabled: usize,
    pub shift_data: usize,
    pub flip_overflow: usize,
    pub flip_data: usize,
    pub size_data: usize,
    pub arrow_data: usize,
    pub hide_data: usize,
    /// `middlewareData`: the six built-in entries, then one per custom
    /// middleware name (each a nullable custom data record).
    pub middleware_data: usize,
    /// The data records of custom middleware (all fields nullable), if any.
    pub custom_data: Option<usize>,
    /// `{ x, y, initialPlacement, placement, strategy, middlewareData, rects, elements }`.
    pub state: usize,
    /// The state, then `availableWidth`, `availableHeight` (size's `apply`).
    pub apply_state: usize,
    /// `{ x, y, data }` (a custom middleware's result).
    pub ret: usize,
    /// `{ x, y, placement, strategy, middlewareData }`.
    pub position: usize,
}

fn rec(records: &[RecordType], t: &Type) -> Option<usize> {
    match t {
        Type::Record(r) if *r < records.len() => Some(*r),
        _ => None,
    }
}

fn maybe(t: &Type) -> Option<&Type> {
    match t {
        Type::Maybe(i) => Some(i),
        _ => None,
    }
}

/// The record `r`'s fields have these names, in order.
fn named(records: &[RecordType], r: usize, names: &[&str]) -> bool {
    let f = &records[r].fields;
    f.len() == names.len() && f.iter().zip(names).all(|(f, n)| f.name == *n)
}

/// Fields `names` of `r`, all of type `t`.
fn uniform(records: &[RecordType], r: usize, names: &[&str], t: &Type) -> bool {
    named(records, r, names) && records[r].fields.iter().all(|f| &f.ty == t)
}

fn field<'a>(records: &'a [RecordType], r: usize, i: usize) -> &'a Type {
    &records[r].fields[i].ty
}

/// The floating shape of middleware record `m` and position record `p`, if
/// they and the records they reach have the pack's shapes.
pub fn floating_shape(records: &[RecordType], m: usize, p: usize) -> Option<FloatingShape> {
    use Type::*;
    let n = Number;
    let s = String;
    let b = Boolean;
    let mn = Maybe(Box::new(Number));
    let ms = Maybe(Box::new(String));
    let mb = Maybe(Box::new(Boolean));
    if m >= records.len() || p >= records.len() {
        return None;
    }
    // The position and middlewareData.
    if !named(
        records,
        p,
        &["x", "y", "placement", "strategy", "middlewareData"],
    ) {
        return None;
    }
    let pf = &records[p].fields;
    if pf[0].ty != n || pf[1].ty != n || pf[2].ty != s || pf[3].ty != s {
        return None;
    }
    let middleware_data = rec(records, &pf[4].ty)?;
    let md = &records[middleware_data].fields;
    let builtin = ["offset", "shift", "flip", "size", "arrow", "hide"];
    if md.len() < builtin.len() || md.iter().zip(builtin).any(|(f, n)| f.name != n) {
        return None;
    }
    let entry = |i: usize| maybe(&md[i].ty).and_then(|t| rec(records, t));
    let offset_data = entry(0)?;
    let shift_data = entry(1)?;
    let flip_data = entry(2)?;
    let size_data = entry(3)?;
    let arrow_data = entry(4)?;
    let hide_data = entry(5)?;
    // Custom entries: one data record, all fields nullable.
    let mut custom_data = None;
    for f in &md[builtin.len()..] {
        let r = maybe(&f.ty).and_then(|t| rec(records, t))?;
        if custom_data.is_some_and(|c| c != r) {
            return None;
        }
        custom_data = Some(r);
    }
    if !named(records, offset_data, &["x", "y", "placement"])
        || records[offset_data].fields[0].ty != n
        || records[offset_data].fields[1].ty != n
        || records[offset_data].fields[2].ty != s
    {
        return None;
    }
    if !named(records, shift_data, &["x", "y", "enabled"])
        || field(records, shift_data, 0) != &n
        || field(records, shift_data, 1) != &n
    {
        return None;
    }
    let shift_enabled = rec(records, field(records, shift_data, 2))?;
    if !uniform(records, shift_enabled, &["x", "y"], &b) {
        return None;
    }
    if !named(records, flip_data, &["index", "overflows"]) || field(records, flip_data, 0) != &mn {
        return None;
    }
    let flip_overflow = match maybe(field(records, flip_data, 1)) {
        Some(Array(e)) => rec(records, e)?,
        _ => return None,
    };
    if !named(records, flip_overflow, &["placement", "overflows"])
        || field(records, flip_overflow, 0) != &s
        || field(records, flip_overflow, 1) != &Array(Box::new(Number))
    {
        return None;
    }
    if !records[size_data].fields.is_empty() {
        return None;
    }
    if !uniform(
        records,
        arrow_data,
        &["x", "y", "centerOffset", "alignmentOffset"],
        &mn,
    ) {
        return None;
    }
    if !named(
        records,
        hide_data,
        &[
            "referenceHiddenOffsets",
            "referenceHidden",
            "escapedOffsets",
            "escaped",
        ],
    ) || field(records, hide_data, 1) != &mb
        || field(records, hide_data, 3) != &mb
    {
        return None;
    }
    let side_object = maybe(field(records, hide_data, 0)).and_then(|t| rec(records, t))?;
    if field(records, hide_data, 2) != &Maybe(Box::new(Record(side_object)))
        || !uniform(
            records,
            side_object,
            &["top", "right", "bottom", "left"],
            &n,
        )
    {
        return None;
    }
    if let Some(c) = custom_data
        && records[c].fields.iter().any(|f| maybe(&f.ty).is_none())
    {
        return None;
    }
    // The middleware and its options.
    if !named(records, m, &["name", "kind", "options", "fn"])
        || field(records, m, 0) != &s
        || field(records, m, 1) != &n
    {
        return None;
    }
    let options = rec(records, field(records, m, 2))?;
    if !named(records, options, &OPTIONS) {
        return None;
    }
    let o = |i: usize| field(records, options, i);
    let limiter = maybe(o(7)).and_then(|t| rec(records, t))?;
    let padding_sides = maybe(o(9)).and_then(|t| rec(records, t))?;
    let elements_t = Maybe(Box::new(Array(Box::new(Element))));
    let strings = Maybe(Box::new(Array(Box::new(String))));
    let numbers = [0, 1, 2, 3, 8];
    let bools = [4, 5, 6, 13, 17];
    let texts = [11, 12, 15, 16, 20];
    if numbers.iter().any(|&i| o(i) != &mn)
        || bools.iter().any(|&i| o(i) != &mb)
        || texts.iter().any(|&i| o(i) != &ms)
        || o(10) != &elements_t
        || o(14) != &strings
        || o(19) != &Maybe(Box::new(Element))
    {
        return None;
    }
    if !named(
        records,
        limiter,
        &[
            "offset",
            "offsetMainAxis",
            "offsetCrossAxis",
            "mainAxis",
            "crossAxis",
        ],
    ) || (0..3).any(|i| field(records, limiter, i) != &mn)
        || (3..5).any(|i| field(records, limiter, i) != &mb)
        || !uniform(
            records,
            padding_sides,
            &["top", "right", "bottom", "left"],
            &mn,
        )
    {
        return None;
    }
    // apply: (applyState) => void; fn: (state) => ret.
    let apply_state = match maybe(o(18)) {
        Some(Fn(f)) if f.params.len() == 1 && *f.result == Void => rec(records, &f.params[0])?,
        _ => return None,
    };
    let (state, ret) = match maybe(field(records, m, 3)) {
        Some(Fn(f)) if f.params.len() == 1 => {
            (rec(records, &f.params[0])?, rec(records, &f.result)?)
        }
        _ => return None,
    };
    let state_names = [
        "x",
        "y",
        "initialPlacement",
        "placement",
        "strategy",
        "middlewareData",
        "rects",
        "elements",
    ];
    if !named(records, state, &state_names) {
        return None;
    }
    let sf = &records[state].fields;
    if sf[0].ty != n
        || sf[1].ty != n
        || sf[2].ty != s
        || sf[3].ty != s
        || sf[4].ty != s
        || sf[5].ty != Record(middleware_data)
    {
        return None;
    }
    let element_rects = rec(records, &sf[6].ty)?;
    let elements = rec(records, &sf[7].ty)?;
    let mut apply_names = state_names.to_vec();
    apply_names.extend(["availableWidth", "availableHeight"]);
    if !named(records, apply_state, &apply_names)
        || records[apply_state].fields[..8]
            .iter()
            .zip(sf)
            .any(|(a, b)| a.ty != b.ty)
        || records[apply_state].fields[8].ty != n
        || records[apply_state].fields[9].ty != n
    {
        return None;
    }
    if !named(records, element_rects, &["reference", "floating"]) {
        return None;
    }
    let rect = rec(records, field(records, element_rects, 0))?;
    if field(records, element_rects, 1) != &Record(rect)
        || !uniform(records, rect, &["x", "y", "width", "height"], &n)
        || !uniform(records, elements, &["reference", "floating"], &Element)
    {
        return None;
    }
    let data = match custom_data {
        Some(c) => Maybe(Box::new(Record(c))),
        None => match records[ret].fields.get(2).map(|f| &f.ty) {
            Some(t @ Maybe(_)) => t.clone(),
            _ => return None,
        },
    };
    if !named(records, ret, &["x", "y", "data"])
        || field(records, ret, 0) != &mn
        || field(records, ret, 1) != &mn
        || field(records, ret, 2) != &data
    {
        return None;
    }
    Some(FloatingShape {
        middleware: m,
        options,
        limiter,
        padding_sides,
        rect,
        element_rects,
        elements,
        side_object,
        offset_data,
        shift_enabled,
        shift_data,
        flip_overflow,
        flip_data,
        size_data,
        arrow_data,
        hide_data,
        middleware_data,
        custom_data,
        state,
        apply_state,
        ret,
        position: p,
    })
}

/// The floating shape a program's `floating.compute` calls use: the
/// middleware record (`array<middleware>` argument) and the position
/// record (`promise<position>` result) of the first call found.
pub fn program_shape(records: &[RecordType], m: &Type, result: &Type) -> Option<FloatingShape> {
    let m = match m {
        Type::Array(e) => rec(records, e)?,
        _ => return None,
    };
    let p = match result {
        Type::Promise(p) => rec(records, p)?,
        _ => return None,
    };
    floating_shape(records, m, p)
}
