//! `@floating-ui/core` 1.7.3's `computePosition` with the middleware `offset`,
//! `shift` (and its `limitShift` limiter), `flip`, `size`, `arrow`, `hide` and
//! custom middleware, as `@floating-ui/dom` 1.7.4's `computePosition` wrapper
//! and `platform` object drive it (with `@floating-ui/utils` 0.2.10's
//! helpers). docs/design/M6-OVERLAYS.md decides that this package is a pack:
//! the positioning math is native here and validated against vectors computed
//! with the real packages in Node (tests/vectors/floating.mjs).
//!
//! The port follows the JavaScript line by line: the same floating-point
//! operations in the same order (`Math.min`/`Math.max` with JavaScript's NaN
//! and signed-zero rules, `x || 0` falsiness), the same key presence of
//! `middlewareData`, the same reset loop (`resetCount <= 50`) and the same
//! fallback strategies.
//!
//! # Microtask timing
//!
//! `computePosition` is an `async` function. Each `await` resumes one
//! microtask tick later, and awaiting another async function costs that
//! function's own ticks plus one. Platform reads, custom middleware calls and
//! `size`'s `apply` callback happen at fixed ticks, and the application's
//! other microtasks (framework flushes caused by state that `apply` writes)
//! run in between. [`Computation`] is therefore resumable:
//! [`Computation::step`] runs to the next `await` and returns [`Step::Tick`]
//! (the caller queues a microtask that steps again) or [`Step::Done`] (the
//! promise settles in this job; its `.then` reactions run one tick later).
//! Per call, with `d` the ticks of `detectOverflow` (6 when the floating
//! element's offset parent is an element, 5 when it is the window: two
//! `isElement` awaits, `getClippingRect`, `getOffsetParent`, `getScale` for an
//! element and the conversion):
//!
//! - start: `isRTL(floating)` synchronously, then `getElementRects` (the dom
//!   platform's async function: `getDimensions(floating)` at tick 1,
//!   `getOffsetParent(floating)` at tick 2, `getRectRelativeToOffsetParent`
//!   at tick 3), so the first middleware runs at tick 4;
//! - `offset`: 3 ticks (`isRTL` inside `convertValueToCoords`);
//! - `shift`, `hide`: `d + 2`; `flip`: `d + 3` (`isRTL` first), or 1 when it
//!   skips because `arrow` added an alignment offset;
//! - `size`: `d + 1`, `+1` for `isRTL` on a top/bottom side, then `apply`, `+1`,
//!   `getDimensions(floating)`, `+1`, and `+1` for the caller's await;
//! - `arrow`: `getDimensions(arrow)`, `+1`, `getOffsetParent(arrow)`, `+1`,
//!   the offset parent's client size, `+1` for `isElement` only when that size
//!   is truthy, then `+1`; or 1 tick without an element;
//! - custom middleware: called synchronously, then 1 tick (a throw rejects at
//!   once; a throw in `apply` rejects one tick later, through `size`'s own
//!   promise);
//! - a reset with `rects: true` costs `getElementRects`' 3 ticks.
//!
//! # Element handles
//!
//! `E` is the application's element handle. The dom platform's `isElement`
//! is awaited in `detectOverflow` and `arrow`; it is true for every handle and
//! false for the window ([`OffsetParent::Window`]), so the port only takes
//! its tick. `getDocumentElement` is only reached for references that are not
//! elements (virtual elements); handles always are, so it is never called.
//! Options are plain values: derivable options (functions of the state) and
//! the `autoPlacement` and `inline` middleware are not ported, and custom
//! middleware and `apply` are synchronous callbacks.

use crate::JsResult;
use crate::number::{max, min};
use std::any::Any;
use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

/// A rectangle (`{ x, y, width, height }`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A point or a scale (`{ x, y }`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coords {
    pub x: f64,
    pub y: f64,
}

/// `platform.getDimensions`'s result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Dimensions {
    pub width: f64,
    pub height: f64,
}

/// `getElementRects`' result: the reference relative to the floating
/// element's offset parent, and the floating element at `(0, 0)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ElementRects {
    pub reference: Rect,
    pub floating: Rect,
}

/// A value per side (overflows, padding, `hide`'s offsets).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SideObject {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// A placement's side.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

/// A placement's alignment (`None` in [`Placement`] is centred).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Alignment {
    Start,
    End,
}

/// A placement such as `"top-start"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Placement {
    pub side: Side,
    pub alignment: Option<Alignment>,
}

/// The positioning strategy (`position: absolute` or `fixed`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Strategy {
    Absolute,
    Fixed,
}

/// `getOffsetParent`'s result: an element or the window.
#[derive(Clone, Debug, PartialEq)]
pub enum OffsetParent<E> {
    Element(E),
    Window,
}

/// `detectOverflow`'s `boundary`: `'clippingAncestors'` or elements (dom
/// accepts one element or an array; one element is a one-element list).
#[derive(Clone, Debug, PartialEq)]
pub enum Boundary<E> {
    ClippingAncestors,
    Elements(Vec<E>),
}

/// `detectOverflow`'s `rootBoundary`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RootBoundary {
    Viewport,
    Document,
    Rect(Rect),
}

/// `detectOverflow`'s `elementContext`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElementContext {
    Floating,
    Reference,
}

/// `padding`: a number or a partial side object. An absent side is 0
/// (`{ top: 0, right: 0, bottom: 0, left: 0, ...padding }`); a side that is
/// present but `undefined` must be passed as `Some(NaN)`, which behaves
/// identically in every use.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Padding {
    All(f64),
    Sides {
        top: Option<f64>,
        right: Option<f64>,
        bottom: Option<f64>,
        left: Option<f64>,
    },
}

/// `detectOverflow`'s options, shared by `shift`, `flip`, `size` and `hide`.
/// [`Default`] is the JavaScript defaults (`'clippingAncestors'`,
/// `'viewport'`, `'floating'`, `false`, `0`).
#[derive(Clone, Debug, PartialEq)]
pub struct DetectOverflowOptions<E> {
    pub boundary: Boundary<E>,
    pub root_boundary: RootBoundary,
    pub element_context: ElementContext,
    pub alt_boundary: bool,
    pub padding: Padding,
}

impl<E> Default for DetectOverflowOptions<E> {
    fn default() -> Self {
        DetectOverflowOptions {
            boundary: Boundary::ClippingAncestors,
            root_boundary: RootBoundary::Viewport,
            element_context: ElementContext::Floating,
            alt_boundary: false,
            padding: Padding::All(0.0),
        }
    }
}

/// `offset(options)`: a number (the main axis) or the axes object. In the
/// object, `main_axis`/`cross_axis` use `value || 0` (absent, `undefined`,
/// NaN and zeros become 0) and `alignment_axis` is used when it is a number
/// (`None` for absent, `undefined` or `null`). [`Default`] is `offset()`
/// (`0`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OffsetOptions {
    Value(f64),
    Axes {
        main_axis: Option<f64>,
        cross_axis: Option<f64>,
        alignment_axis: Option<f64>,
    },
}

impl Default for OffsetOptions {
    fn default() -> Self {
        OffsetOptions::Value(0.0)
    }
}

/// `limitShift`'s `offset`: a number (the main axis) or
/// `{ mainAxis: 0, crossAxis: 0, ...offset }` (a key present but `undefined`
/// is `Some(NaN)`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LimitShiftOffset {
    Value(f64),
    Axes {
        main_axis: Option<f64>,
        cross_axis: Option<f64>,
    },
}

/// `limitShift(options)`; [`Default`] is `limitShift()` (offset 0, both axes).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LimitShiftOptions {
    pub offset: LimitShiftOffset,
    pub main_axis: bool,
    pub cross_axis: bool,
}

impl Default for LimitShiftOptions {
    fn default() -> Self {
        LimitShiftOptions {
            offset: LimitShiftOffset::Value(0.0),
            main_axis: true,
            cross_axis: true,
        }
    }
}

/// `shift(options)`; `limiter: None` is the default (no limit, also what
/// `limiter: undefined` gives). [`Default`] is `shift()`.
#[derive(Clone, Debug, PartialEq)]
pub struct ShiftOptions<E> {
    pub main_axis: bool,
    pub cross_axis: bool,
    pub limiter: Option<LimitShiftOptions>,
    pub overflow: DetectOverflowOptions<E>,
}

impl<E> Default for ShiftOptions<E> {
    fn default() -> Self {
        ShiftOptions {
            main_axis: true,
            cross_axis: false,
            limiter: None,
            overflow: DetectOverflowOptions::default(),
        }
    }
}

/// `flip`'s `crossAxis`: `true`, `false` or `'alignment'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlipCrossAxis {
    True,
    False,
    Alignment,
}

/// `flip`'s `fallbackStrategy`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FallbackStrategy {
    BestFit,
    InitialPlacement,
}

/// `flip`'s `fallbackAxisSideDirection`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FallbackAxisSideDirection {
    None,
    Start,
    End,
}

/// `flip(options)`; [`Default`] is `flip()`. `fallback_placements:
/// Some(vec![])` is a specified empty list (truthy in JavaScript).
#[derive(Clone, Debug, PartialEq)]
pub struct FlipOptions<E> {
    pub main_axis: bool,
    pub cross_axis: FlipCrossAxis,
    pub fallback_placements: Option<Vec<Placement>>,
    pub fallback_strategy: FallbackStrategy,
    pub fallback_axis_side_direction: FallbackAxisSideDirection,
    pub flip_alignment: bool,
    pub overflow: DetectOverflowOptions<E>,
}

impl<E> Default for FlipOptions<E> {
    fn default() -> Self {
        FlipOptions {
            main_axis: true,
            cross_axis: FlipCrossAxis::True,
            fallback_placements: None,
            fallback_strategy: FallbackStrategy::BestFit,
            fallback_axis_side_direction: FallbackAxisSideDirection::None,
            flip_alignment: true,
            overflow: DetectOverflowOptions::default(),
        }
    }
}

/// `size(options)`: `apply` is a callback id answered by
/// [`Platform::apply_size`] (`None`: the default no-op, still awaited).
#[derive(Clone, Debug, PartialEq)]
pub struct SizeOptions<E> {
    pub apply: Option<usize>,
    pub overflow: DetectOverflowOptions<E>,
}

impl<E> Default for SizeOptions<E> {
    fn default() -> Self {
        SizeOptions {
            apply: None,
            overflow: DetectOverflowOptions::default(),
        }
    }
}

/// `arrow({ element, padding })`; `element: None` (`null`) makes the
/// middleware return `{}`.
#[derive(Clone, Debug, PartialEq)]
pub struct ArrowOptions<E> {
    pub element: Option<E>,
    pub padding: Padding,
}

/// `hide`'s `strategy`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HideStrategy {
    ReferenceHidden,
    Escaped,
}

/// `hide(options)`; [`Default`] is `hide()` (`'referenceHidden'`).
#[derive(Clone, Debug, PartialEq)]
pub struct HideOptions<E> {
    pub strategy: HideStrategy,
    pub overflow: DetectOverflowOptions<E>,
}

impl<E> Default for HideOptions<E> {
    fn default() -> Self {
        HideOptions {
            strategy: HideStrategy::ReferenceHidden,
            overflow: DetectOverflowOptions::default(),
        }
    }
}

/// One entry of `computePosition`'s `middleware` (after `.filter(Boolean)`).
/// A custom middleware's `fn` is [`Platform::call_custom`] with `id`; its
/// `name` must differ from the built-in names (`offset`, `shift`, `flip`,
/// `size`, `arrow`, `hide`), whose data has fixed shapes here.
#[derive(Clone, Debug, PartialEq)]
pub enum Middleware<E> {
    Offset(OffsetOptions),
    Shift(ShiftOptions<E>),
    Flip(FlipOptions<E>),
    Size(SizeOptions<E>),
    Arrow(ArrowOptions<E>),
    Hide(HideOptions<E>),
    Custom { name: String, id: usize },
}

/// `middlewareData.offset`: always `{ x, y, placement }` (written on its
/// first run; a later run that skips keeps the previous object).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OffsetData {
    pub x: f64,
    pub y: f64,
    pub placement: Placement,
}

/// `middlewareData.shift.enabled`: `{ x, y }`, both always present.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShiftEnabled {
    pub x: bool,
    pub y: bool,
}

/// `middlewareData.shift`: always `{ x, y, enabled }`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShiftData {
    pub x: f64,
    pub y: f64,
    pub enabled: ShiftEnabled,
}

/// One element of `middlewareData.flip.overflows`: the overflows checked for
/// a placement (main side if `mainAxis`, then both alignment sides if
/// `crossAxis`).
#[derive(Clone, Debug, PartialEq)]
pub struct PlacementOverflows {
    pub placement: Placement,
    pub overflows: Vec<f64>,
}

/// `middlewareData.flip`: `{}` until it moves to a fallback placement, then
/// `{ index, overflows }` (both written together).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FlipData {
    pub index: Option<usize>,
    pub overflows: Option<Vec<PlacementOverflows>>,
}

/// `middlewareData.size`: always `{}` (`size` returns no data).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SizeData;

/// `middlewareData.arrow`: `{}` when it has no element; otherwise each run
/// writes the alignment axis' coordinate (`x` or `y`) and `centerOffset`,
/// and `alignmentOffset` when it added one. Keys from earlier runs stay (a
/// reset to a placement on the other axis leaves both `x` and `y`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ArrowData {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub center_offset: Option<f64>,
    pub alignment_offset: Option<f64>,
}

/// `middlewareData.hide`: `referenceHiddenOffsets` and `referenceHidden`
/// (strategy `'referenceHidden'`), `escapedOffsets` and `escaped`
/// (`'escaped'`); two `hide` middleware share the entry.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HideData {
    pub reference_hidden_offsets: Option<SideObject>,
    pub reference_hidden: Option<bool>,
    pub escaped_offsets: Option<SideObject>,
    pub escaped: Option<bool>,
}

/// `middlewareData`, as `computePosition` builds it:
/// `{ ...middlewareData, [name]: { ...middlewareData[name], ...data } }`
/// after every middleware run. An entry exists for every middleware that has
/// run (an empty object if it returned no data) and each key keeps its
/// previous value unless the new data has it. Custom entries are opaque `D`
/// values merged by [`Platform::merge_custom`], in order of first run. Key
/// order inside the JavaScript object is not modelled.
#[derive(Clone, Debug, PartialEq)]
pub struct MiddlewareData<D> {
    pub offset: Option<OffsetData>,
    pub shift: Option<ShiftData>,
    pub flip: Option<FlipData>,
    pub size: Option<SizeData>,
    pub arrow: Option<ArrowData>,
    pub hide: Option<HideData>,
    pub custom: Vec<(String, D)>,
}

impl<D> Default for MiddlewareData<D> {
    fn default() -> Self {
        MiddlewareData {
            offset: None,
            shift: None,
            flip: None,
            size: None,
            arrow: None,
            hide: None,
            custom: Vec::new(),
        }
    }
}

impl<D> MiddlewareData<D> {
    /// A custom middleware's entry (`middlewareData[name]`).
    pub fn custom(&self, name: &str) -> Option<&D> {
        self.custom.iter().find(|(n, _)| n == name).map(|(_, d)| d)
    }
}

/// The state a custom middleware's `fn` (and `size`'s `apply`) receives.
/// `platform` and `elements` are the caller's own.
#[derive(Debug)]
pub struct MiddlewareState<'a, E, D> {
    pub x: f64,
    pub y: f64,
    pub initial_placement: Placement,
    pub placement: Placement,
    pub strategy: Strategy,
    pub middleware_data: &'a MiddlewareData<D>,
    pub rects: ElementRects,
    pub reference: &'a E,
    pub floating: &'a E,
}

/// `resetRects`: `true` (recompute with `getElementRects`) or rectangles.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ResetRects {
    Recompute,
    Rects(ElementRects),
}

/// A middleware's `reset` (a falsy value is `None` in [`MiddlewareReturn`]).
/// `True` restarts the middleware list without recomputing the coordinates;
/// `Object` (even an empty one) applies its placement and rects and
/// recomputes them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reset {
    True,
    Object {
        placement: Option<Placement>,
        rects: Option<ResetRects>,
    },
}

/// A custom middleware's result; `x`/`y` `None` is `undefined` or `null`
/// (keep the current coordinate), `data: None` is no data.
#[derive(Clone, Debug, PartialEq)]
pub struct MiddlewareReturn<D> {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub data: Option<D>,
    pub reset: Option<Reset>,
}

/// `computePosition`'s resolved value.
#[derive(Clone, Debug, PartialEq)]
pub struct Position<D> {
    pub x: f64,
    pub y: f64,
    pub placement: Placement,
    pub strategy: Strategy,
    pub middleware_data: MiddlewareData<D>,
}

/// Synchronous platform primitives. The generated application implements them
/// over its native layout with the semantics of `@floating-ui/dom` 1.7.4's
/// functions of the same name; [`Computation`] calls them at the ticks where
/// the JavaScript does.
pub trait Platform<E, D> {
    /// `platform.isRTL(element)`.
    fn is_rtl(&mut self, element: &E) -> bool;
    /// `platform.getDimensions(element)`.
    fn get_dimensions(&mut self, element: &E) -> Dimensions;
    /// `platform.getOffsetParent(element)`.
    fn get_offset_parent(&mut self, element: &E) -> OffsetParent<E>;
    /// dom's `getRectRelativeToOffsetParent(element, offsetParent, strategy)`
    /// (called by `getElementRects` for the reference).
    fn get_rect_relative_to_offset_parent(
        &mut self,
        element: &E,
        offset_parent: &OffsetParent<E>,
        strategy: Strategy,
    ) -> Rect;
    /// `platform.getClippingRect({ element, boundary, rootBoundary, strategy })`.
    fn get_clipping_rect(
        &mut self,
        element: &E,
        boundary: &Boundary<E>,
        root_boundary: &RootBoundary,
        strategy: Strategy,
    ) -> Rect;
    /// `platform.getScale(element)` (only asked for element offset parents).
    fn get_scale(&mut self, element: &E) -> Coords;
    /// `platform.convertOffsetParentRelativeRectToViewportRelativeRect({
    /// elements: { reference, floating }, rect, offsetParent, strategy })`.
    fn convert_offset_parent_relative_rect_to_viewport_relative_rect(
        &mut self,
        reference: &E,
        floating: &E,
        rect: Rect,
        offset_parent: &OffsetParent<E>,
        strategy: Strategy,
    ) -> Rect;
    /// `target.clientWidth` (`width`) or `target.clientHeight` (`arrow`);
    /// `None` for the window (`undefined`).
    fn client_size(&mut self, target: &OffsetParent<E>, width: bool) -> Option<f64>;
    /// A custom middleware's `fn(state)`; an exception rejects the promise.
    fn call_custom(
        &mut self,
        id: usize,
        state: &MiddlewareState<E, D>,
    ) -> JsResult<MiddlewareReturn<D>>;
    /// `size`'s `apply({ ...state, availableWidth, availableHeight })`.
    fn apply_size(
        &mut self,
        id: usize,
        state: &MiddlewareState<E, D>,
        available_width: f64,
        available_height: f64,
    ) -> JsResult<()>;
    /// `{ ...old, ...new }` for a custom entry (`None`: absent or no data).
    fn merge_custom(&mut self, old: Option<&D>, new: Option<&D>) -> D;
}

/// The result of one [`Computation::step`].
#[derive(Debug)]
pub enum Step<D> {
    /// Suspended at an `await`: queue a microtask that steps again.
    Tick,
    /// The promise settles in this job (rejected with a callback's throw).
    Done(JsResult<Position<D>>),
}

/// One `computePosition(reference, floating, { placement, strategy,
/// middleware })` call of `@floating-ui/dom`, as a resumable computation.
pub struct Computation<E, D> {
    mail: Rc<RefCell<Mail<E, D>>>,
    future: Option<Pin<Box<dyn Future<Output = JsResult<Position<D>>>>>>,
}

impl<E: Clone + 'static, D: Clone + 'static> Computation<E, D> {
    /// Prepares the call; nothing runs before the first [`step`](Self::step).
    pub fn new(
        reference: E,
        floating: E,
        placement: Placement,
        strategy: Strategy,
        middleware: Vec<Middleware<E>>,
    ) -> Self {
        let mail = Rc::new(RefCell::new(Mail {
            request: None,
            response: None,
            tick: false,
        }));
        let run = Run {
            host: Host(mail.clone()),
            reference,
            floating,
            strategy,
        };
        let future = Box::pin(async move { run.compute_position(placement, middleware).await });
        Computation {
            mail,
            future: Some(future),
        }
    }

    /// Runs until the next `await` ([`Step::Tick`]) or the end
    /// ([`Step::Done`]). Call it first synchronously where JavaScript calls
    /// `computePosition`, then once per queued microtask. Platform calls
    /// happen inside. Panics when called again after [`Step::Done`].
    pub fn step(&mut self, platform: &mut dyn Platform<E, D>) -> Step<D> {
        let future = self
            .future
            .as_mut()
            .expect("Computation::step after the computation settled");
        let mut cx = Context::from_waker(Waker::noop());
        loop {
            match future.as_mut().poll(&mut cx) {
                Poll::Ready(result) => {
                    self.future = None;
                    return Step::Done(result);
                }
                Poll::Pending => {
                    let request = {
                        let mut mail = self.mail.borrow_mut();
                        match mail.request.take() {
                            Some(request) => request,
                            None => {
                                assert!(mail.tick, "suspended without a request or a tick");
                                mail.tick = false;
                                return Step::Tick;
                            }
                        }
                    };
                    let response = request(platform);
                    self.mail.borrow_mut().response = Some(response);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Suspension: platform requests answered by `step`, and microtask ticks.

type Request<E, D> = Box<dyn FnOnce(&mut dyn Platform<E, D>) -> Box<dyn Any>>;

struct Mail<E, D> {
    request: Option<Request<E, D>>,
    response: Option<Box<dyn Any>>,
    tick: bool,
}

/// Pending once, then ready.
struct Suspend(bool);

impl Future for Suspend {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<()> {
        if self.0 {
            Poll::Ready(())
        } else {
            self.0 = true;
            Poll::Pending
        }
    }
}

struct Host<E, D>(Rc<RefCell<Mail<E, D>>>);

impl<E: 'static, D: 'static> Host<E, D> {
    /// A synchronous platform access (within the current job).
    async fn call<R: 'static>(&self, f: impl FnOnce(&mut dyn Platform<E, D>) -> R + 'static) -> R {
        self.0.borrow_mut().request = Some(Box::new(move |p: &mut dyn Platform<E, D>| {
            Box::new(f(p)) as Box<dyn Any>
        }));
        Suspend(false).await;
        let response = self.0.borrow_mut().response.take();
        *response
            .expect("platform response")
            .downcast::<R>()
            .expect("platform response type")
    }

    /// One microtask tick: `await` of a value or of a promise settled now.
    async fn tick(&self) {
        self.0.borrow_mut().tick = true;
        Suspend(false).await;
    }

    /// `await platform.method(...)` for a synchronous method: the call now,
    /// the result one tick later.
    async fn read<R: 'static>(&self, f: impl FnOnce(&mut dyn Platform<E, D>) -> R + 'static) -> R {
        let r = self.call(f).await;
        self.tick().await;
        r
    }
}

// ---------------------------------------------------------------------------
// @floating-ui/utils

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Axis {
    X,
    Y,
}

impl Axis {
    fn opposite(self) -> Axis {
        match self {
            Axis::X => Axis::Y,
            Axis::Y => Axis::X,
        }
    }
}

impl Side {
    /// The side's name.
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Top => "top",
            Side::Right => "right",
            Side::Bottom => "bottom",
            Side::Left => "left",
        }
    }

    /// `oppositeSideMap[side]`.
    pub fn opposite(self) -> Side {
        match self {
            Side::Top => Side::Bottom,
            Side::Bottom => Side::Top,
            Side::Left => Side::Right,
            Side::Right => Side::Left,
        }
    }
}

impl Alignment {
    fn opposite(self) -> Alignment {
        match self {
            Alignment::Start => Alignment::End,
            Alignment::End => Alignment::Start,
        }
    }
}

impl Placement {
    /// The 12 placements in `placements`' order.
    pub const ALL: [Placement; 12] = {
        const fn p(side: Side, alignment: Option<Alignment>) -> Placement {
            Placement { side, alignment }
        }
        use Alignment::*;
        use Side::*;
        [
            p(Top, None),
            p(Top, Some(Start)),
            p(Top, Some(End)),
            p(Right, None),
            p(Right, Some(Start)),
            p(Right, Some(End)),
            p(Bottom, None),
            p(Bottom, Some(Start)),
            p(Bottom, Some(End)),
            p(Left, None),
            p(Left, Some(Start)),
            p(Left, Some(End)),
        ]
    };

    /// `"top"`, `"top-start"`, ...; `None` for anything else.
    pub fn parse(s: &str) -> Option<Placement> {
        Placement::ALL.into_iter().find(|p| p.as_str() == s)
    }

    /// The placement's name.
    pub fn as_str(self) -> &'static str {
        use Alignment::*;
        use Side::*;
        match (self.side, self.alignment) {
            (Top, None) => "top",
            (Top, Some(Start)) => "top-start",
            (Top, Some(End)) => "top-end",
            (Right, None) => "right",
            (Right, Some(Start)) => "right-start",
            (Right, Some(End)) => "right-end",
            (Bottom, None) => "bottom",
            (Bottom, Some(Start)) => "bottom-start",
            (Bottom, Some(End)) => "bottom-end",
            (Left, None) => "left",
            (Left, Some(Start)) => "left-start",
            (Left, Some(End)) => "left-end",
        }
    }
}

impl Strategy {
    /// `"absolute"` or `"fixed"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Strategy::Absolute => "absolute",
            Strategy::Fixed => "fixed",
        }
    }
}

impl Rect {
    fn at(&self, axis: Axis) -> f64 {
        match axis {
            Axis::X => self.x,
            Axis::Y => self.y,
        }
    }

    /// `rect[getAxisLength(axis)]`.
    fn length(&self, axis: Axis) -> f64 {
        match axis {
            Axis::X => self.width,
            Axis::Y => self.height,
        }
    }
}

impl Dimensions {
    fn length(&self, axis: Axis) -> f64 {
        match axis {
            Axis::X => self.width,
            Axis::Y => self.height,
        }
    }
}

impl Coords {
    fn at(&self, axis: Axis) -> f64 {
        match axis {
            Axis::X => self.x,
            Axis::Y => self.y,
        }
    }

    fn set(&mut self, axis: Axis, value: f64) {
        match axis {
            Axis::X => self.x = value,
            Axis::Y => self.y = value,
        }
    }
}

impl SideObject {
    fn get(&self, side: Side) -> f64 {
        match side {
            Side::Top => self.top,
            Side::Right => self.right,
            Side::Bottom => self.bottom,
            Side::Left => self.left,
        }
    }
}

/// `rectToClientRect`'s edges.
struct ClientRect {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

fn rect_to_client_rect(rect: Rect) -> ClientRect {
    ClientRect {
        top: rect.y,
        left: rect.x,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
    }
}

fn clamp(start: f64, value: f64, end: f64) -> f64 {
    max(start, min(value, end))
}

/// `value || 0`.
fn or_zero(value: Option<f64>) -> f64 {
    match value {
        Some(v) if v != 0.0 && !v.is_nan() => v,
        _ => 0.0,
    }
}

/// A number's truthiness.
fn truthy(value: Option<f64>) -> bool {
    matches!(value, Some(v) if v != 0.0 && !v.is_nan())
}

fn get_side_axis(placement: Placement) -> Axis {
    match placement.side {
        Side::Top | Side::Bottom => Axis::Y,
        Side::Left | Side::Right => Axis::X,
    }
}

fn get_alignment_axis(placement: Placement) -> Axis {
    get_side_axis(placement).opposite()
}

fn get_opposite_placement(placement: Placement) -> Placement {
    Placement {
        side: placement.side.opposite(),
        alignment: placement.alignment,
    }
}

fn get_opposite_alignment_placement(placement: Placement) -> Placement {
    Placement {
        side: placement.side,
        alignment: placement.alignment.map(Alignment::opposite),
    }
}

fn get_alignment_sides(placement: Placement, rects: &ElementRects, rtl: bool) -> [Side; 2] {
    let alignment = placement.alignment;
    let alignment_axis = get_alignment_axis(placement);
    let mut main_alignment_side = if alignment_axis == Axis::X {
        let start = if rtl {
            Alignment::End
        } else {
            Alignment::Start
        };
        if alignment == Some(start) {
            Side::Right
        } else {
            Side::Left
        }
    } else if alignment == Some(Alignment::Start) {
        Side::Bottom
    } else {
        Side::Top
    };
    if rects.reference.length(alignment_axis) > rects.floating.length(alignment_axis) {
        main_alignment_side = main_alignment_side.opposite();
    }
    [main_alignment_side, main_alignment_side.opposite()]
}

fn get_expanded_placements(placement: Placement) -> Vec<Placement> {
    let opposite_placement = get_opposite_placement(placement);
    vec![
        get_opposite_alignment_placement(placement),
        opposite_placement,
        get_opposite_alignment_placement(opposite_placement),
    ]
}

fn get_side_list(side: Side, is_start: bool, rtl: bool) -> [Side; 2] {
    const LR: [Side; 2] = [Side::Left, Side::Right];
    const RL: [Side; 2] = [Side::Right, Side::Left];
    const TB: [Side; 2] = [Side::Top, Side::Bottom];
    const BT: [Side; 2] = [Side::Bottom, Side::Top];
    match side {
        Side::Top | Side::Bottom => {
            if rtl {
                if is_start { RL } else { LR }
            } else if is_start {
                LR
            } else {
                RL
            }
        }
        Side::Left | Side::Right => {
            if is_start {
                TB
            } else {
                BT
            }
        }
    }
}

fn get_opposite_axis_placements(
    placement: Placement,
    flip_alignment: bool,
    is_start: bool,
    rtl: bool,
) -> Vec<Placement> {
    let alignment = placement.alignment;
    let mut list: Vec<Placement> = get_side_list(placement.side, is_start, rtl)
        .into_iter()
        .map(|side| Placement { side, alignment })
        .collect();
    if alignment.is_some() && flip_alignment {
        let flipped: Vec<Placement> = list
            .iter()
            .map(|&p| get_opposite_alignment_placement(p))
            .collect();
        list.extend(flipped);
    }
    list
}

fn get_padding_object(padding: &Padding) -> SideObject {
    match *padding {
        Padding::All(v) => SideObject {
            top: v,
            right: v,
            bottom: v,
            left: v,
        },
        Padding::Sides {
            top,
            right,
            bottom,
            left,
        } => SideObject {
            top: top.unwrap_or(0.0),
            right: right.unwrap_or(0.0),
            bottom: bottom.unwrap_or(0.0),
            left: left.unwrap_or(0.0),
        },
    }
}

/// `array.sort(compare)[0]`: the first element of the stable sort (the
/// earliest element that no other sorts strictly before). Equal to V8's
/// result for consistent comparators, which those used here are (finite
/// differences, or NaN throughout when every operand is missing).
fn first_sorted<T>(items: Vec<T>, compare: impl Fn(&T, &T) -> f64) -> Option<T> {
    let mut best: Option<T> = None;
    for item in items {
        match &best {
            Some(b) if !(compare(&item, b) < 0.0) => {}
            _ => best = Some(item),
        }
    }
    best
}

// ---------------------------------------------------------------------------
// @floating-ui/core

fn compute_coords_from_placement(rects: &ElementRects, placement: Placement, rtl: bool) -> Coords {
    let reference = rects.reference;
    let floating = rects.floating;
    let side_axis = get_side_axis(placement);
    let alignment_axis = get_alignment_axis(placement);
    let is_vertical = side_axis == Axis::Y;
    let common_x = reference.x + reference.width / 2.0 - floating.width / 2.0;
    let common_y = reference.y + reference.height / 2.0 - floating.height / 2.0;
    let common_align =
        reference.length(alignment_axis) / 2.0 - floating.length(alignment_axis) / 2.0;
    let mut coords = match placement.side {
        Side::Top => Coords {
            x: common_x,
            y: reference.y - floating.height,
        },
        Side::Bottom => Coords {
            x: common_x,
            y: reference.y + reference.height,
        },
        Side::Right => Coords {
            x: reference.x + reference.width,
            y: common_y,
        },
        Side::Left => Coords {
            x: reference.x - floating.width,
            y: common_y,
        },
    };
    let sign = if rtl && is_vertical { -1.0 } else { 1.0 };
    match placement.alignment {
        Some(Alignment::Start) => {
            let v = coords.at(alignment_axis) - common_align * sign;
            coords.set(alignment_axis, v);
        }
        Some(Alignment::End) => {
            let v = coords.at(alignment_axis) + common_align * sign;
            coords.set(alignment_axis, v);
        }
        None => {}
    }
    coords
}

/// The middleware state a run sees (`platform` and `elements` live in `Run`).
#[derive(Clone)]
struct Snapshot<D> {
    x: f64,
    y: f64,
    initial_placement: Placement,
    placement: Placement,
    middleware_data: Rc<MiddlewareData<D>>,
    rects: ElementRects,
}

/// A built-in middleware's data.
enum Data {
    Offset(OffsetData),
    Shift(ShiftData),
    Flip(FlipData),
    Arrow(ArrowData),
    Hide(HideData),
}

/// A built-in middleware's result.
struct Ret {
    x: Option<f64>,
    y: Option<f64>,
    data: Option<Data>,
    reset: Option<Reset>,
}

impl Ret {
    fn empty() -> Ret {
        Ret {
            x: None,
            y: None,
            data: None,
            reset: None,
        }
    }
}

struct Run<E, D> {
    host: Host<E, D>,
    reference: E,
    floating: E,
    strategy: Strategy,
}

impl<E: Clone + 'static, D: Clone + 'static> Run<E, D> {
    async fn is_rtl(&self) -> bool {
        let floating = self.floating.clone();
        self.host.read(move |p| p.is_rtl(&floating)).await
    }

    async fn get_dimensions(&self, element: &E) -> Dimensions {
        let element = element.clone();
        self.host.read(move |p| p.get_dimensions(&element)).await
    }

    async fn get_offset_parent(&self, element: &E) -> OffsetParent<E> {
        let element = element.clone();
        self.host.read(move |p| p.get_offset_parent(&element)).await
    }

    /// dom's `getElementRects` (an async function: two awaits); the caller's
    /// `await` adds a tick.
    async fn get_element_rects(&self) -> ElementRects {
        let floating_dimensions = self.get_dimensions(&self.floating).await;
        let offset_parent = self.get_offset_parent(&self.floating).await;
        let (reference, strategy) = (self.reference.clone(), self.strategy);
        let reference = self
            .host
            .call(move |p| {
                p.get_rect_relative_to_offset_parent(&reference, &offset_parent, strategy)
            })
            .await;
        ElementRects {
            reference,
            floating: Rect {
                x: 0.0,
                y: 0.0,
                width: floating_dimensions.width,
                height: floating_dimensions.height,
            },
        }
    }

    /// Calls `f` with the JavaScript middleware state of `s`.
    async fn with_state<R: 'static>(
        &self,
        s: &Snapshot<D>,
        f: impl FnOnce(&mut dyn Platform<E, D>, &MiddlewareState<E, D>) -> R + 'static,
    ) -> R {
        let (s, reference, floating, strategy) = (
            s.clone(),
            self.reference.clone(),
            self.floating.clone(),
            self.strategy,
        );
        self.host
            .call(move |p| {
                let state = MiddlewareState {
                    x: s.x,
                    y: s.y,
                    initial_placement: s.initial_placement,
                    placement: s.placement,
                    strategy,
                    middleware_data: &s.middleware_data,
                    rects: s.rects,
                    reference: &reference,
                    floating: &floating,
                };
                f(p, &state)
            })
            .await
    }

    async fn compute_position(
        &self,
        placement: Placement,
        middleware: Vec<Middleware<E>>,
    ) -> JsResult<Position<D>> {
        let rtl = self.is_rtl().await;
        let mut rects = self.get_element_rects().await;
        self.host.tick().await;
        let Coords { mut x, mut y } = compute_coords_from_placement(&rects, placement, rtl);
        let mut stateful_placement = placement;
        let mut middleware_data: Rc<MiddlewareData<D>> = Rc::new(MiddlewareData::default());
        let mut reset_count = 0;
        let mut i = 0;
        while i < middleware.len() {
            let state = Snapshot {
                x,
                y,
                initial_placement: placement,
                placement: stateful_placement,
                middleware_data: middleware_data.clone(),
                rects,
            };
            let mut next = (*middleware_data).clone();
            let (next_x, next_y, reset) = match &middleware[i] {
                Middleware::Custom { name, id } => {
                    let id = *id;
                    // `fn` runs synchronously: a throw rejects now.
                    let r = self
                        .with_state(&state, move |p, s| p.call_custom(id, s))
                        .await?;
                    self.host.tick().await;
                    let previous = next.custom(name).cloned();
                    let new = r.data;
                    let merged = self
                        .host
                        .call(move |p| p.merge_custom(previous.as_ref(), new.as_ref()))
                        .await;
                    match next.custom.iter_mut().find(|(n, _)| n == name) {
                        Some(entry) => entry.1 = merged,
                        None => next.custom.push((name.clone(), merged)),
                    }
                    (r.x, r.y, r.reset)
                }
                builtin => {
                    let r = self.builtin(builtin, &state).await;
                    self.host.tick().await;
                    let r = r?;
                    merge(&mut next, builtin, r.data);
                    (r.x, r.y, r.reset)
                }
            };
            x = next_x.unwrap_or(x);
            y = next_y.unwrap_or(y);
            middleware_data = Rc::new(next);
            i += 1;
            if let Some(reset) = reset
                && reset_count <= 50
            {
                reset_count += 1;
                if let Reset::Object {
                    placement: reset_placement,
                    rects: reset_rects,
                } = reset
                {
                    if let Some(p) = reset_placement {
                        stateful_placement = p;
                    }
                    if let Some(r) = reset_rects {
                        rects = match r {
                            ResetRects::Recompute => {
                                let r = self.get_element_rects().await;
                                self.host.tick().await;
                                r
                            }
                            ResetRects::Rects(r) => r,
                        };
                    }
                    Coords { x, y } =
                        compute_coords_from_placement(&rects, stateful_placement, rtl);
                }
                i = 0;
            }
        }
        Ok(Position {
            x,
            y,
            placement: stateful_placement,
            strategy: self.strategy,
            middleware_data: Rc::unwrap_or_clone(middleware_data),
        })
    }

    async fn builtin(&self, m: &Middleware<E>, s: &Snapshot<D>) -> JsResult<Ret> {
        Ok(match m {
            Middleware::Offset(o) => self.offset(o, s).await,
            Middleware::Shift(o) => self.shift(o, s).await,
            Middleware::Flip(o) => self.flip(o, s).await,
            Middleware::Size(o) => self.size(o, s).await?,
            Middleware::Arrow(o) => self.arrow(o, s).await,
            Middleware::Hide(o) => self.hide(o, s).await,
            Middleware::Custom { .. } => unreachable!("custom middleware is called directly"),
        })
    }

    async fn detect_overflow(&self, s: &Snapshot<D>, o: &DetectOverflowOptions<E>) -> SideObject {
        let padding_object = get_padding_object(&o.padding);
        let alt_context = match o.element_context {
            ElementContext::Floating => ElementContext::Reference,
            ElementContext::Reference => ElementContext::Floating,
        };
        let context = if o.alt_boundary {
            alt_context
        } else {
            o.element_context
        };
        let element = match context {
            ElementContext::Floating => self.floating.clone(),
            ElementContext::Reference => self.reference.clone(),
        };
        // `await platform.isElement(element)`: true for a handle.
        self.host.tick().await;
        let (boundary, root_boundary, strategy) =
            (o.boundary.clone(), o.root_boundary, self.strategy);
        let clipping_rect = self
            .host
            .read(move |p| p.get_clipping_rect(&element, &boundary, &root_boundary, strategy))
            .await;
        let clipping_client_rect = rect_to_client_rect(clipping_rect);
        let rect = match o.element_context {
            ElementContext::Floating => Rect {
                x: s.x,
                y: s.y,
                width: s.rects.floating.width,
                height: s.rects.floating.height,
            },
            ElementContext::Reference => s.rects.reference,
        };
        let offset_parent = self.get_offset_parent(&self.floating).await;
        // `await platform.isElement(offsetParent)`.
        self.host.tick().await;
        let offset_scale = match &offset_parent {
            OffsetParent::Element(e) => {
                let e = e.clone();
                self.host.read(move |p| p.get_scale(&e)).await
            }
            OffsetParent::Window => Coords { x: 1.0, y: 1.0 },
        };
        let (reference, floating) = (self.reference.clone(), self.floating.clone());
        let converted = self
            .host
            .read(move |p| {
                p.convert_offset_parent_relative_rect_to_viewport_relative_rect(
                    &reference,
                    &floating,
                    rect,
                    &offset_parent,
                    strategy,
                )
            })
            .await;
        let element_client_rect = rect_to_client_rect(converted);
        SideObject {
            top: (clipping_client_rect.top - element_client_rect.top + padding_object.top)
                / offset_scale.y,
            bottom: (element_client_rect.bottom - clipping_client_rect.bottom
                + padding_object.bottom)
                / offset_scale.y,
            left: (clipping_client_rect.left - element_client_rect.left + padding_object.left)
                / offset_scale.x,
            right: (element_client_rect.right - clipping_client_rect.right + padding_object.right)
                / offset_scale.x,
        }
    }

    /// `await detectOverflow(...)` from a middleware: its ticks plus one.
    async fn await_detect_overflow(
        &self,
        s: &Snapshot<D>,
        o: &DetectOverflowOptions<E>,
    ) -> SideObject {
        let overflow = self.detect_overflow(s, o).await;
        self.host.tick().await;
        overflow
    }

    async fn convert_value_to_coords(&self, s: &Snapshot<D>, options: &OffsetOptions) -> Coords {
        let placement = s.placement;
        let rtl = self.is_rtl().await;
        let side = placement.side;
        let alignment = placement.alignment;
        let is_vertical = get_side_axis(placement) == Axis::Y;
        let main_axis_multi = if matches!(side, Side::Left | Side::Top) {
            -1.0
        } else {
            1.0
        };
        let cross_axis_multi = if rtl && is_vertical { -1.0 } else { 1.0 };
        let (main_axis, mut cross_axis, alignment_axis) = match *options {
            OffsetOptions::Value(v) => (v, 0.0, None),
            OffsetOptions::Axes {
                main_axis,
                cross_axis,
                alignment_axis,
            } => (or_zero(main_axis), or_zero(cross_axis), alignment_axis),
        };
        if let (Some(alignment), Some(alignment_axis)) = (alignment, alignment_axis) {
            cross_axis = if alignment == Alignment::End {
                alignment_axis * -1.0
            } else {
                alignment_axis
            };
        }
        if is_vertical {
            Coords {
                x: cross_axis * cross_axis_multi,
                y: main_axis * main_axis_multi,
            }
        } else {
            Coords {
                x: main_axis * main_axis_multi,
                y: cross_axis * cross_axis_multi,
            }
        }
    }

    async fn offset(&self, options: &OffsetOptions, s: &Snapshot<D>) -> Ret {
        let diff_coords = self.convert_value_to_coords(s, options).await;
        self.host.tick().await;
        let md = &s.middleware_data;
        if Some(s.placement) == md.offset.map(|o| o.placement)
            && truthy(md.arrow.and_then(|a| a.alignment_offset))
        {
            return Ret::empty();
        }
        Ret {
            x: Some(s.x + diff_coords.x),
            y: Some(s.y + diff_coords.y),
            data: Some(Data::Offset(OffsetData {
                x: diff_coords.x,
                y: diff_coords.y,
                placement: s.placement,
            })),
            reset: None,
        }
    }

    async fn shift(&self, o: &ShiftOptions<E>, s: &Snapshot<D>) -> Ret {
        let (x, y) = (s.x, s.y);
        let coords = Coords { x, y };
        let overflow = self.await_detect_overflow(s, &o.overflow).await;
        let cross_axis = get_side_axis(s.placement);
        let main_axis = cross_axis.opposite();
        let mut main_axis_coord = coords.at(main_axis);
        let mut cross_axis_coord = coords.at(cross_axis);
        if o.main_axis {
            let (min_side, max_side) = if main_axis == Axis::Y {
                (Side::Top, Side::Bottom)
            } else {
                (Side::Left, Side::Right)
            };
            let lo = main_axis_coord + overflow.get(min_side);
            let hi = main_axis_coord - overflow.get(max_side);
            main_axis_coord = clamp(lo, main_axis_coord, hi);
        }
        if o.cross_axis {
            let (min_side, max_side) = if cross_axis == Axis::Y {
                (Side::Top, Side::Bottom)
            } else {
                (Side::Left, Side::Right)
            };
            let lo = cross_axis_coord + overflow.get(min_side);
            let hi = cross_axis_coord - overflow.get(max_side);
            cross_axis_coord = clamp(lo, cross_axis_coord, hi);
        }
        let mut limiter_state = s.clone();
        let mut shifted = Coords { x, y };
        shifted.set(main_axis, main_axis_coord);
        shifted.set(cross_axis, cross_axis_coord);
        limiter_state.x = shifted.x;
        limiter_state.y = shifted.y;
        let limited = match &o.limiter {
            None => shifted,
            Some(l) => limit_shift(l, &limiter_state),
        };
        let mut enabled = ShiftEnabled { x: false, y: false };
        match main_axis {
            Axis::X => enabled.x = o.main_axis,
            Axis::Y => enabled.y = o.main_axis,
        }
        match cross_axis {
            Axis::X => enabled.x = o.cross_axis,
            Axis::Y => enabled.y = o.cross_axis,
        }
        Ret {
            x: Some(limited.x),
            y: Some(limited.y),
            data: Some(Data::Shift(ShiftData {
                x: limited.x - x,
                y: limited.y - y,
                enabled,
            })),
            reset: None,
        }
    }

    async fn flip(&self, o: &FlipOptions<E>, s: &Snapshot<D>) -> Ret {
        let placement = s.placement;
        let initial_placement = s.initial_placement;
        let md = &s.middleware_data;
        if truthy(md.arrow.and_then(|a| a.alignment_offset)) {
            return Ret::empty();
        }
        let side = placement.side;
        let initial_side_axis = get_side_axis(initial_placement);
        let is_base_placement = initial_placement.alignment.is_none();
        let rtl = self.is_rtl().await;
        let has_fallback_axis_side_direction =
            o.fallback_axis_side_direction != FallbackAxisSideDirection::None;
        let fallback_placements = match &o.fallback_placements {
            Some(specified) => specified.clone(),
            None => {
                let mut list = if is_base_placement || !o.flip_alignment {
                    vec![get_opposite_placement(initial_placement)]
                } else {
                    get_expanded_placements(initial_placement)
                };
                if has_fallback_axis_side_direction {
                    list.extend(get_opposite_axis_placements(
                        initial_placement,
                        o.flip_alignment,
                        o.fallback_axis_side_direction == FallbackAxisSideDirection::Start,
                        rtl,
                    ));
                }
                list
            }
        };
        let mut placements = vec![initial_placement];
        placements.extend(fallback_placements);
        let overflow = self.await_detect_overflow(s, &o.overflow).await;
        let mut overflows = Vec::new();
        let mut overflows_data = md
            .flip
            .as_ref()
            .and_then(|f| f.overflows.clone())
            .unwrap_or_default();
        if o.main_axis {
            overflows.push(overflow.get(side));
        }
        if o.cross_axis != FlipCrossAxis::False {
            let sides = get_alignment_sides(placement, &s.rects, rtl);
            overflows.push(overflow.get(sides[0]));
            overflows.push(overflow.get(sides[1]));
        }
        overflows_data.push(PlacementOverflows {
            placement,
            overflows: overflows.clone(),
        });
        // `d.overflows[k]` (undefined, so NaN in comparisons, when absent).
        let at = |d: &PlacementOverflows, k: usize| d.overflows.get(k).copied().unwrap_or(f64::NAN);

        if !overflows.iter().all(|&side| side <= 0.0) {
            let next_index = md.flip.as_ref().and_then(|f| f.index).unwrap_or(0) + 1;
            if let Some(&next_placement) = placements.get(next_index) {
                let ignore_cross_axis_overflow = if o.cross_axis == FlipCrossAxis::Alignment {
                    initial_side_axis != get_side_axis(next_placement)
                } else {
                    false
                };
                if !ignore_cross_axis_overflow
                    || overflows_data.iter().all(|d| {
                        if get_side_axis(d.placement) == initial_side_axis {
                            at(d, 0) > 0.0
                        } else {
                            true
                        }
                    })
                {
                    return Ret {
                        x: None,
                        y: None,
                        data: Some(Data::Flip(FlipData {
                            index: Some(next_index),
                            overflows: Some(overflows_data),
                        })),
                        reset: Some(Reset::Object {
                            placement: Some(next_placement),
                            rects: None,
                        }),
                    };
                }
            }

            let mut reset_placement = first_sorted(
                overflows_data
                    .iter()
                    .filter(|d| at(d, 0) <= 0.0)
                    .collect::<Vec<_>>(),
                |a, b| at(a, 1) - at(b, 1),
            )
            .map(|d| d.placement);

            if reset_placement.is_none() {
                match o.fallback_strategy {
                    FallbackStrategy::BestFit => {
                        let candidates: Vec<(Placement, f64)> = overflows_data
                            .iter()
                            .filter(|d| {
                                if has_fallback_axis_side_direction {
                                    let current_side_axis = get_side_axis(d.placement);
                                    current_side_axis == initial_side_axis
                                        || current_side_axis == Axis::Y
                                } else {
                                    true
                                }
                            })
                            .map(|d| {
                                let total = d
                                    .overflows
                                    .iter()
                                    .filter(|&&overflow| overflow > 0.0)
                                    .fold(0.0, |acc, &overflow| acc + overflow);
                                (d.placement, total)
                            })
                            .collect();
                        if let Some((p, _)) = first_sorted(candidates, |a, b| a.1 - b.1) {
                            reset_placement = Some(p);
                        }
                    }
                    FallbackStrategy::InitialPlacement => {
                        reset_placement = Some(initial_placement);
                    }
                }
            }
            if Some(placement) != reset_placement {
                return Ret {
                    x: None,
                    y: None,
                    data: None,
                    reset: Some(Reset::Object {
                        placement: reset_placement,
                        rects: None,
                    }),
                };
            }
        }
        Ret::empty()
    }

    async fn size(&self, o: &SizeOptions<E>, s: &Snapshot<D>) -> JsResult<Ret> {
        let placement = s.placement;
        let overflow = self.await_detect_overflow(s, &o.overflow).await;
        let side = placement.side;
        let alignment = placement.alignment;
        let is_y_axis = get_side_axis(placement) == Axis::Y;
        let Rect { width, height, .. } = s.rects.floating;
        let (height_side, width_side) = if side == Side::Top || side == Side::Bottom {
            let rtl = self.is_rtl().await;
            let start_side = if rtl {
                Alignment::Start
            } else {
                Alignment::End
            };
            (
                side,
                if alignment == Some(start_side) {
                    Side::Left
                } else {
                    Side::Right
                },
            )
        } else {
            (
                if alignment == Some(Alignment::End) {
                    Side::Top
                } else {
                    Side::Bottom
                },
                side,
            )
        };
        let maximum_clipping_height = height - overflow.top - overflow.bottom;
        let maximum_clipping_width = width - overflow.left - overflow.right;
        let overflow_available_height =
            min(height - overflow.get(height_side), maximum_clipping_height);
        let overflow_available_width =
            min(width - overflow.get(width_side), maximum_clipping_width);
        let shift = s.middleware_data.shift;
        let no_shift = shift.is_none();
        let mut available_height = overflow_available_height;
        let mut available_width = overflow_available_width;
        if shift.is_some_and(|s| s.enabled.x) {
            available_width = maximum_clipping_width;
        }
        if shift.is_some_and(|s| s.enabled.y) {
            available_height = maximum_clipping_height;
        }
        if no_shift && alignment.is_none() {
            let x_min = max(overflow.left, 0.0);
            let x_max = max(overflow.right, 0.0);
            let y_min = max(overflow.top, 0.0);
            let y_max = max(overflow.bottom, 0.0);
            if is_y_axis {
                available_width = width
                    - 2.0
                        * (if x_min != 0.0 || x_max != 0.0 {
                            x_min + x_max
                        } else {
                            max(overflow.left, overflow.right)
                        });
            } else {
                available_height = height
                    - 2.0
                        * (if y_min != 0.0 || y_max != 0.0 {
                            y_min + y_max
                        } else {
                            max(overflow.top, overflow.bottom)
                        });
            }
        }
        if let Some(id) = o.apply {
            self.with_state(s, move |p, state| {
                p.apply_size(id, state, available_width, available_height)
            })
            .await?;
        }
        self.host.tick().await;
        let next_dimensions = self.get_dimensions(&self.floating).await;
        if width != next_dimensions.width || height != next_dimensions.height {
            return Ok(Ret {
                x: None,
                y: None,
                data: None,
                reset: Some(Reset::Object {
                    placement: None,
                    rects: Some(ResetRects::Recompute),
                }),
            });
        }
        Ok(Ret::empty())
    }

    async fn arrow(&self, o: &ArrowOptions<E>, s: &Snapshot<D>) -> Ret {
        let Some(element) = o.element.clone() else {
            return Ret::empty();
        };
        let placement = s.placement;
        let rects = s.rects;
        let padding_object = get_padding_object(&o.padding);
        let coords = Coords { x: s.x, y: s.y };
        let axis = get_alignment_axis(placement);
        let arrow_dimensions = self.get_dimensions(&element).await;
        let is_y_axis = axis == Axis::Y;
        let (min_prop, max_prop) = if is_y_axis {
            (Side::Top, Side::Bottom)
        } else {
            (Side::Left, Side::Right)
        };
        let width = !is_y_axis;
        let end_diff = rects.reference.length(axis) + rects.reference.at(axis)
            - coords.at(axis)
            - rects.floating.length(axis);
        let start_diff = coords.at(axis) - rects.reference.at(axis);
        let arrow_offset_parent = self.get_offset_parent(&element).await;
        let target = arrow_offset_parent.clone();
        let client_size = self.host.call(move |p| p.client_size(&target, width)).await;
        // `!clientSize || !(await platform.isElement(arrowOffsetParent))`
        let fall_back = if !truthy(client_size) {
            true
        } else {
            self.host.tick().await;
            matches!(arrow_offset_parent, OffsetParent::Window)
        };
        let client_size = if fall_back {
            let floating = OffsetParent::Element(self.floating.clone());
            let floating_size = self
                .host
                .call(move |p| p.client_size(&floating, width))
                .await;
            match floating_size {
                Some(v) if truthy(Some(v)) => v,
                _ => rects.floating.length(axis),
            }
        } else {
            client_size.unwrap_or(f64::NAN)
        };
        let arrow_length = arrow_dimensions.length(axis);
        let center_to_reference = end_diff / 2.0 - start_diff / 2.0;
        let largest_possible_padding = client_size / 2.0 - arrow_length / 2.0 - 1.0;
        let min_padding = min(padding_object.get(min_prop), largest_possible_padding);
        let max_padding = min(padding_object.get(max_prop), largest_possible_padding);
        let min_ = min_padding;
        let max_ = client_size - arrow_length - max_padding;
        let center = client_size / 2.0 - arrow_length / 2.0 + center_to_reference;
        let offset = clamp(min_, center, max_);
        let should_add_offset = s.middleware_data.arrow.is_none()
            && placement.alignment.is_some()
            && center != offset
            && rects.reference.length(axis) / 2.0
                - (if center < min_ {
                    min_padding
                } else {
                    max_padding
                })
                - arrow_length / 2.0
                < 0.0;
        let alignment_offset = if should_add_offset {
            if center < min_ {
                center - min_
            } else {
                center - max_
            }
        } else {
            0.0
        };
        let coordinate = coords.at(axis) + alignment_offset;
        let mut data = ArrowData {
            center_offset: Some(center - offset - alignment_offset),
            alignment_offset: should_add_offset.then_some(alignment_offset),
            ..ArrowData::default()
        };
        let (x, y) = match axis {
            Axis::X => {
                data.x = Some(offset);
                (Some(coordinate), None)
            }
            Axis::Y => {
                data.y = Some(offset);
                (None, Some(coordinate))
            }
        };
        Ret {
            x,
            y,
            data: Some(Data::Arrow(data)),
            reset: should_add_offset.then_some(Reset::True),
        }
    }

    async fn hide(&self, o: &HideOptions<E>, s: &Snapshot<D>) -> Ret {
        let rects = s.rects;
        let data = match o.strategy {
            HideStrategy::ReferenceHidden => {
                let options = DetectOverflowOptions {
                    element_context: ElementContext::Reference,
                    ..o.overflow.clone()
                };
                let overflow = self.await_detect_overflow(s, &options).await;
                let offsets = get_side_offsets(overflow, rects.reference);
                HideData {
                    reference_hidden_offsets: Some(offsets),
                    reference_hidden: Some(is_any_side_fully_clipped(offsets)),
                    ..HideData::default()
                }
            }
            HideStrategy::Escaped => {
                let options = DetectOverflowOptions {
                    alt_boundary: true,
                    ..o.overflow.clone()
                };
                let overflow = self.await_detect_overflow(s, &options).await;
                let offsets = get_side_offsets(overflow, rects.floating);
                HideData {
                    escaped_offsets: Some(offsets),
                    escaped: Some(is_any_side_fully_clipped(offsets)),
                    ..HideData::default()
                }
            }
        };
        Ret {
            x: None,
            y: None,
            data: Some(Data::Hide(data)),
            reset: None,
        }
    }
}

fn limit_shift<D>(o: &LimitShiftOptions, s: &Snapshot<D>) -> Coords {
    let (x, y) = (s.x, s.y);
    let placement = s.placement;
    let rects = s.rects;
    let coords = Coords { x, y };
    let cross_axis = get_side_axis(placement);
    let main_axis = cross_axis.opposite();
    let mut main_axis_coord = coords.at(main_axis);
    let mut cross_axis_coord = coords.at(cross_axis);
    let (offset_main, offset_cross) = match o.offset {
        LimitShiftOffset::Value(v) => (v, 0.0),
        LimitShiftOffset::Axes {
            main_axis,
            cross_axis,
        } => (main_axis.unwrap_or(0.0), cross_axis.unwrap_or(0.0)),
    };
    if o.main_axis {
        let limit_min =
            rects.reference.at(main_axis) - rects.floating.length(main_axis) + offset_main;
        let limit_max =
            rects.reference.at(main_axis) + rects.reference.length(main_axis) - offset_main;
        if main_axis_coord < limit_min {
            main_axis_coord = limit_min;
        } else if main_axis_coord > limit_max {
            main_axis_coord = limit_max;
        }
    }
    if o.cross_axis {
        let is_origin_side = matches!(placement.side, Side::Left | Side::Top);
        let data_offset = or_zero(s.middleware_data.offset.map(|d| match cross_axis {
            Axis::X => d.x,
            Axis::Y => d.y,
        }));
        let limit_min = rects.reference.at(cross_axis) - rects.floating.length(cross_axis)
            + (if is_origin_side { data_offset } else { 0.0 })
            + (if is_origin_side { 0.0 } else { offset_cross });
        let limit_max = rects.reference.at(cross_axis)
            + rects.reference.length(cross_axis)
            + (if is_origin_side { 0.0 } else { data_offset })
            - (if is_origin_side { offset_cross } else { 0.0 });
        if cross_axis_coord < limit_min {
            cross_axis_coord = limit_min;
        } else if cross_axis_coord > limit_max {
            cross_axis_coord = limit_max;
        }
    }
    let mut out = Coords { x, y };
    out.set(main_axis, main_axis_coord);
    out.set(cross_axis, cross_axis_coord);
    out
}

fn get_side_offsets(overflow: SideObject, rect: Rect) -> SideObject {
    SideObject {
        top: overflow.top - rect.height,
        right: overflow.right - rect.width,
        bottom: overflow.bottom - rect.height,
        left: overflow.left - rect.width,
    }
}

fn is_any_side_fully_clipped(overflow: SideObject) -> bool {
    [overflow.top, overflow.right, overflow.bottom, overflow.left]
        .into_iter()
        .any(|v| v >= 0.0)
}

/// `middlewareData[name] = { ...middlewareData[name], ...data }` for a
/// built-in middleware.
fn merge<E, D>(md: &mut MiddlewareData<D>, m: &Middleware<E>, data: Option<Data>) {
    match (m, data) {
        (Middleware::Offset(_), Some(Data::Offset(d))) => md.offset = Some(d),
        (Middleware::Offset(_), _) => {
            // `offset` returns no data only when its entry exists already.
            debug_assert!(md.offset.is_some(), "offset skipped without data");
        }
        (Middleware::Shift(_), Some(Data::Shift(d))) => md.shift = Some(d),
        (Middleware::Shift(_), _) => unreachable!("shift always returns data"),
        (Middleware::Flip(_), data) => {
            let mut entry = md.flip.take().unwrap_or_default();
            if let Some(Data::Flip(d)) = data {
                if d.index.is_some() {
                    entry.index = d.index;
                }
                if d.overflows.is_some() {
                    entry.overflows = d.overflows;
                }
            }
            md.flip = Some(entry);
        }
        (Middleware::Size(_), _) => md.size = Some(SizeData),
        (Middleware::Arrow(_), data) => {
            let mut entry = md.arrow.unwrap_or_default();
            if let Some(Data::Arrow(d)) = data {
                entry.x = d.x.or(entry.x);
                entry.y = d.y.or(entry.y);
                entry.center_offset = d.center_offset.or(entry.center_offset);
                entry.alignment_offset = d.alignment_offset.or(entry.alignment_offset);
            }
            md.arrow = Some(entry);
        }
        (Middleware::Hide(_), data) => {
            let mut entry = md.hide.unwrap_or_default();
            if let Some(Data::Hide(d)) = data {
                entry.reference_hidden_offsets = d
                    .reference_hidden_offsets
                    .or(entry.reference_hidden_offsets);
                entry.reference_hidden = d.reference_hidden.or(entry.reference_hidden);
                entry.escaped_offsets = d.escaped_offsets.or(entry.escaped_offsets);
                entry.escaped = d.escaped.or(entry.escaped);
            }
            md.hide = Some(entry);
        }
        (Middleware::Custom { .. }, _) => unreachable!("custom data is merged by the platform"),
    }
}
