//! Reference interpreter: the executable definition of schema 5 semantics.
//!
//! It renders a program to an abstract DOM and fires events at elements by
//! their `id`, applying the same DOM rules as the native runtime (disabled
//! elements ignore activation; read-only inputs ignore edits). Values use the
//! shared `runic-js` semantics, so differential tests against generated code
//! check lowering and code generation rather than the built-ins themselves.

use crate::*;
use runic_js::{
    self as js, ArrayElement, JsArray, JsMap, JsRef, JsSet, JsString, MapKey, Maybe, Throw,
    ToMapKey,
};
use serde_json::{Map, Value as Json, json};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::rc::Rc;

/// Field values of a record, with its record type index.
#[derive(Clone, Debug)]
pub struct RecordData {
    pub record: usize,
    /// Field values (`undefined` for derived class fields, whose values are
    /// in `derived`).
    pub fields: Vec<Val>,
    /// A class instance (never proxied by deep state).
    pub class: bool,
    /// Cached derived class fields by field index (M6 stage B).
    derived: HashMap<usize, DerivedSlot>,
}

impl RecordData {
    pub fn new(record: usize, fields: Vec<Val>, class: bool) -> Self {
        RecordData {
            record,
            fields,
            class,
            derived: HashMap::new(),
        }
    }
}

#[derive(Debug)]
pub struct Closure {
    pub function: usize,
    pub captures: Vec<Rc<RefCell<Val>>>,
    /// The component instance a component function runs in.
    pub instance: Option<usize>,
    /// The instance's render snapshot when the closure was created: its
    /// `snapshot` reads see that render (React closures).
    pub snapshot: Option<Rc<Vec<Val>>>,
}

/// An image object's state (M6 images).
#[derive(Debug, Default)]
pub struct ImageObject {
    /// The last `src` written (none: never written).
    pub src: Option<JsString>,
    pub cross_origin: Option<&'static str>,
    pub referrer_policy: &'static str,
    /// `(error, handler, function)`, in order: `load` or `error`, and
    /// whether it is the `onload`/`onerror` handler (which keeps the place
    /// of its first assignment, as the DOM's event handlers do).
    pub listeners: Vec<(bool, bool, Val)>,
}

/// A dynamic value.
#[derive(Clone, Debug)]
pub enum Val {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(JsString),
    Array(JsArray<Val>),
    Record(JsRef<RecordData>),
    Map(JsMap<Val, Val>),
    Set(JsSet<Val>),
    Closure(Rc<Closure>),
    Element(js::Element),
    Event(js::Event),
    /// An attribute bag: entries in order (a later entry of a name wins).
    Attrs(Rc<Vec<(String, Val)>>),
    Promise(Promise),
    /// A promise's resolve or reject function.
    Resolver(Rc<Resolver>),
    /// Event listeners composed by `attrs.merge-props` (svelte-toolbelt's
    /// `composeHandlers`): each runs with the event unless it was cancelled.
    Listeners(Rc<Vec<Val>>),
    RegExp(js::RegExp),
    MediaQuery(js::MediaQueryList),
    Date(js::Date),
    /// An imperatively mounted instance (M6): its id while it is mounted.
    Mounted(Rc<std::cell::Cell<Option<usize>>>),
    /// The contexts instance `i` sees (`context.all`).
    Contexts(usize),
    /// An image object (`new Image()`, M6 images). The interpreter loads
    /// no images: it keeps what the program sets and never fires `load`
    /// or `error` (the differential reports such programs incomplete).
    Image(Rc<RefCell<ImageObject>>),
    /// A dynamic object (M6 spike): properties in insertion order.
    DynObject(JsRef<Vec<(JsString, Val)>>),
    /// A static value boxed into a dynamic one (M6 spike).
    Boxed(Rc<dynamic::Boxed>),
    /// A static function made from a dynamic one: its static type and the
    /// dynamic function (M6 spike).
    DynFn(Rc<(crate::FnType, Val)>),
}

#[path = "interp_dyn.rs"]
mod dynamic;

/// Promises of the interpreter: reactions become [`PJob`]s on the microtask queue.
pub type Promise = js::JsPromise<Val, PJob>;

/// The resolve (or reject) function of a promise; only its first call counts.
pub struct Resolver {
    promise: Promise,
    reject: bool,
    done: Rc<std::cell::Cell<bool>>,
}

impl std::fmt::Debug for Resolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.reject { "reject" } else { "resolve" })
    }
}

/// A promise job (ECMAScript's PromiseReactionJob and
/// NewPromiseResolveThenableJob).
pub enum PJob {
    /// Run the handler for `outcome` and resolve `derived` with its result.
    Reaction {
        outcome: Res<Val>,
        handler: PHandler,
        derived: Promise,
    },
    /// Resolving `promise` with the promise `thenable` subscribes to it.
    Adopt { promise: Promise, thenable: Promise },
}

pub enum PHandler {
    /// `then(onFulfilled, onRejected)`; a missing handler passes the outcome on.
    Then(Option<Val>, Option<Val>),
    /// `finally(onFinally)`.
    Finally(Val),
    /// Element `index` of `Promise.all`.
    All(Rc<AllState>, usize),
}

pub struct AllState {
    values: RefCell<Vec<Val>>,
    remaining: std::cell::Cell<usize>,
}

impl Val {
    fn num(&self) -> f64 {
        match self {
            Val::Num(n) => *n,
            other => panic!("validated number, found {other:?}"),
        }
    }
    fn boolean(&self) -> bool {
        match self {
            Val::Bool(b) => *b,
            other => panic!("validated boolean, found {other:?}"),
        }
    }
    fn string(&self) -> JsString {
        match self {
            Val::Str(s) => s.clone(),
            other => panic!("validated string, found {other:?}"),
        }
    }
    /// A string, or nothing for undefined and null.
    fn as_string(&self) -> Option<JsString> {
        match self {
            Val::Str(s) => Some(s.clone()),
            _ => None,
        }
    }
    fn array(&self) -> JsArray<Val> {
        match self {
            Val::Array(a) => a.clone(),
            other => panic!("validated array, found {other:?}"),
        }
    }
    fn maybe_num(&self) -> Maybe<f64> {
        match self {
            Val::Undefined => Maybe::Undefined,
            Val::Null => Maybe::Null,
            v => Maybe::Some(v.num()),
        }
    }
    fn maybe_str(&self) -> Maybe<JsString> {
        match self {
            Val::Undefined => Maybe::Undefined,
            Val::Null => Maybe::Null,
            v => Maybe::Some(v.string()),
        }
    }
    fn from_maybe(m: Maybe<Val>) -> Val {
        match m {
            Maybe::Some(v) => v,
            Maybe::Null => Val::Null,
            Maybe::Undefined => Val::Undefined,
        }
    }
    pub fn from_literal(v: &Value) -> Val {
        match v {
            Value::Boolean(b) => Val::Bool(*b),
            Value::Number(n) => Val::Num(*n),
            Value::String(s) => Val::Str(JsString::from(s.as_str())),
        }
    }
    /// SameValue (`Object.is`), used to detect changed cells.
    pub fn same(&self, other: &Val) -> bool {
        match (self, other) {
            (Val::Num(a), Val::Num(b)) => js::same_value(*a, *b),
            _ => js::StrictEq::strict_eq(self, other),
        }
    }
}

impl js::StrictEq for Val {
    fn strict_eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Val::Undefined, Val::Undefined) | (Val::Null, Val::Null) => true,
            (Val::Bool(a), Val::Bool(b)) => a == b,
            (Val::Num(a), Val::Num(b)) => a == b,
            (Val::Str(a), Val::Str(b)) => a == b,
            (Val::Array(a), Val::Array(b)) => JsRef::ptr_eq(a, b),
            (Val::Record(a), Val::Record(b)) => JsRef::ptr_eq(a, b),
            (Val::Map(a), Val::Map(b)) => JsRef::ptr_eq(a, b),
            (Val::Set(a), Val::Set(b)) => JsRef::ptr_eq(a, b),
            (Val::Closure(a), Val::Closure(b)) => Rc::ptr_eq(a, b),
            (Val::Resolver(a), Val::Resolver(b)) => Rc::ptr_eq(a, b),
            (Val::Listeners(a), Val::Listeners(b)) => Rc::ptr_eq(a, b),
            (Val::Promise(a), Val::Promise(b)) => a == b,
            (Val::Element(a), Val::Element(b)) => a == b,
            (Val::Event(a), Val::Event(b)) => a == b,
            (Val::RegExp(a), Val::RegExp(b)) => a == b,
            (Val::MediaQuery(a), Val::MediaQuery(b)) => a == b,
            (Val::Date(a), Val::Date(b)) => a == b,
            (Val::Mounted(a), Val::Mounted(b)) => Rc::ptr_eq(a, b),
            (Val::Contexts(a), Val::Contexts(b)) => a == b,
            (Val::Image(a), Val::Image(b)) => Rc::ptr_eq(a, b),
            (Val::DynObject(a), Val::DynObject(b)) => JsRef::ptr_eq(a, b),
            (Val::DynFn(a), Val::DynFn(b)) => Rc::ptr_eq(a, b),
            (Val::Boxed(a), Val::Boxed(b)) => a.value.strict_eq(&b.value),
            (Val::Attrs(a), Val::Attrs(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .zip(b.iter())
                        .all(|((n, x), (m, y))| n == m && x.same(y))
            }
            _ => false,
        }
    }
}

impl js::Truthy for Val {
    fn truthy(&self) -> bool {
        match self {
            Val::Undefined | Val::Null => false,
            Val::Bool(b) => *b,
            Val::Num(n) => n.truthy(),
            Val::Str(s) => !s.is_empty(),
            _ => true,
        }
    }
}

impl js::HeapToString for RecordData {
    fn heap_to_string(&self) -> JsString {
        JsString::from("[object Object]")
    }
}

impl js::ToJsString for Val {
    fn to_js_string(&self) -> JsString {
        match self {
            Val::Undefined => JsString::from("undefined"),
            Val::Null => JsString::from("null"),
            Val::Bool(b) => b.to_js_string(),
            Val::Num(n) => n.to_js_string(),
            Val::Str(s) => s.clone(),
            Val::Array(a) => a.to_js_string(),
            Val::Record(r) => r.to_js_string(),
            Val::Map(_) => JsString::from("[object Map]"),
            Val::Set(_) => JsString::from("[object Set]"),
            Val::Closure(_) | Val::Resolver(_) | Val::Listeners(_) => JsString::from("function"),
            Val::Element(e) => e.to_js_string(),
            Val::Event(e) => e.to_js_string(),
            Val::RegExp(r) => r.to_js_string(),
            Val::MediaQuery(_) => JsString::from("[object MediaQueryList]"),
            Val::Date(d) => d.to_js_string(),
            Val::Attrs(_) | Val::Mounted(_) => JsString::from("[object Object]"),
            Val::Contexts(_) => JsString::from("[object Map]"),
            Val::Image(_) => JsString::from("[object HTMLImageElement]"),
            Val::Promise(_) => JsString::from("[object Promise]"),
            // (Dynamic values convert with dyn.to-string, which can throw.)
            Val::DynObject(_) | Val::Boxed(_) | Val::DynFn(_) => {
                unreachable!("validated: dynamic values convert with dyn.to-string")
            }
        }
    }
}

impl ArrayElement for Val {
    fn join_string(&self) -> JsString {
        match self {
            Val::Undefined | Val::Null => JsString::new(),
            v => js::ToJsString::to_js_string(v),
        }
    }
}

impl js::ToNumber for Val {
    fn to_number(&self) -> f64 {
        match self {
            Val::Undefined => f64::NAN,
            Val::Null => 0.0,
            Val::Bool(b) => b.to_number(),
            Val::Num(n) => *n,
            Val::Str(s) => s.to_number(),
            Val::Date(d) => d.time(),
            _ => f64::NAN,
        }
    }
}

impl js::Own for Val {
    fn mark(&self) {
        match self {
            Val::Array(a) => a.mark(),
            Val::Record(r) => r.mark(),
            Val::Map(m) => m.mark(),
            Val::Set(s) => s.mark(),
            _ => {}
        }
    }
    fn own(self) -> Self {
        match self {
            Val::Array(a) => Val::Array(a.own()),
            Val::Record(r) => Val::Record(r.own()),
            other => other,
        }
    }
}

impl js::OwnFields for RecordData {
    const PROXIED: bool = true;
    fn proxied(&self) -> bool {
        !self.class
    }
    fn own_fields(&mut self) {
        use js::Own;
        for f in self.fields.iter_mut() {
            *f = f.clone().own();
        }
    }
    fn mark_fields(&self) {
        use js::Own;
        for f in &self.fields {
            f.mark();
        }
    }
}

impl js::TypeOf for Val {
    fn type_of(&self) -> &'static str {
        match self {
            Val::Undefined => "undefined",
            Val::Bool(_) => "boolean",
            Val::Num(_) => "number",
            Val::Str(_) => "string",
            Val::Closure(_) | Val::Resolver(_) | Val::Listeners(_) => "function",
            _ => "object",
        }
    }
}

impl ToMapKey for Val {
    fn map_key(&self) -> MapKey {
        match self {
            Val::Undefined => MapKey::Undefined,
            Val::Null => MapKey::Null,
            Val::Bool(b) => b.map_key(),
            Val::Num(n) => n.map_key(),
            Val::Str(s) => s.map_key(),
            Val::Array(a) => a.map_key(),
            Val::Record(r) => r.map_key(),
            Val::Map(m) => m.map_key(),
            Val::Set(s) => s.map_key(),
            Val::Closure(c) => MapKey::Ref(Rc::as_ptr(c) as *const u8 as usize),
            Val::Resolver(r) => MapKey::Ref(Rc::as_ptr(r) as *const u8 as usize),
            Val::Listeners(l) => MapKey::Ref(Rc::as_ptr(l) as *const u8 as usize),
            Val::Promise(p) => MapKey::Ref(p.addr()),
            Val::Element(e) => e.map_key(),
            Val::Event(e) => e.map_key(),
            Val::RegExp(r) => r.map_key(),
            Val::MediaQuery(m) => MapKey::Ref(m.id()),
            Val::Date(d) => d.map_key(),
            Val::Attrs(a) => MapKey::Ref(Rc::as_ptr(a) as *const u8 as usize),
            Val::Mounted(m) => MapKey::Ref(Rc::as_ptr(m) as *const u8 as usize),
            Val::Image(i) => MapKey::Ref(Rc::as_ptr(i) as *const u8 as usize),
            // Instance ids never collide with heap addresses in one map (a
            // map's key type is static).
            Val::Contexts(i) => MapKey::Ref(*i),
            Val::DynObject(o) => MapKey::Ref(o.addr()),
            Val::DynFn(f) => MapKey::Ref(Rc::as_ptr(f) as *const u8 as usize),
            Val::Boxed(b) => b.value.map_key(),
        }
    }
}

/// Non-local control flow of statements.
enum Flow {
    Normal,
    Break(Option<String>),
    Continue(Option<String>),
    Return(Val),
}

type Res<T> = std::result::Result<T, Throw>;

/// Function locals. Each slot holds a binding; closures share boxed bindings
/// and copy the values of unboxed ones (which are never reassigned).
struct Frame {
    locals: RefCell<Vec<Rc<RefCell<Val>>>>,
}

impl Frame {
    fn new(n: usize) -> Self {
        Frame {
            locals: RefCell::new(
                (0..n)
                    .map(|_| Rc::new(RefCell::new(Val::Undefined)))
                    .collect(),
            ),
        }
    }
    fn get(&self, i: usize) -> Val {
        self.locals.borrow()[i].borrow().clone()
    }
    fn set(&self, i: usize, v: Val) {
        *self.locals.borrow()[i].borrow_mut() = v;
    }
    /// A fresh binding (`let` executed again, loop iteration).
    fn rebind(&self, i: usize, v: Val) {
        self.locals.borrow_mut()[i] = Rc::new(RefCell::new(v));
    }
    fn binding(&self, i: usize) -> Rc<RefCell<Val>> {
        Rc::clone(&self.locals.borrow()[i])
    }
}

/// JavaScript `===` on values of one static type.
pub fn strict_equal(a: &Val, b: &Val) -> bool {
    js::StrictEq::strict_eq(a, b)
}

pub fn check_domain(cell: &Cell, v: &Val) -> Result<()> {
    if let (Some(Domain::Text { max_utf16 }), Val::Str(s)) = (&cell.domain, v) {
        if !runic_js::valid_single_line(&s.to_rust(), *max_utf16) || s.len() > *max_utf16 {
            return Err(Diagnostic::new(
                "E_TEXT_PAYLOAD",
                format!("Value leaves the text domain of {}", cell.name),
                cell.source.as_ref(),
            ));
        }
    }
    Ok(())
}

/// Abstract DOM node, serialized in the conformance snapshot format.
#[derive(Clone, Debug, PartialEq)]
pub enum VNode {
    Element {
        tag: String,
        attrs: BTreeMap<String, String>,
        value: Option<String>,
        /// Live checked state of checkboxes.
        checked: Option<bool>,
        /// Stable identity (element handles, event targets).
        id: u64,
        listeners: Vec<(EventKind, usize)>,
        children: Vec<VNode>,
    },
    Text(String),
}

impl VNode {
    pub fn to_json(&self) -> Json {
        match self {
            VNode::Text(t) => Json::String(t.clone()),
            VNode::Element {
                tag,
                attrs,
                value,
                checked,
                children,
                ..
            } => {
                let mut o = Map::new();
                o.insert("tag".into(), json!(tag));
                o.insert("attrs".into(), json!(attrs));
                if let Some(c) = checked {
                    o.insert("checked".into(), json!(c));
                }
                if let Some(v) = value {
                    o.insert("value".into(), json!(v));
                }
                o.insert(
                    "children".into(),
                    Json::Array(children.iter().map(VNode::to_json).collect()),
                );
                Json::Object(o)
            }
        }
    }
}

/// Merge adjacent text and drop empty text, as the snapshot format requires.
pub fn normalize(nodes: Vec<VNode>) -> Vec<VNode> {
    let mut out: Vec<VNode> = vec![];
    for n in nodes {
        match n {
            VNode::Text(t) if t.is_empty() => {}
            VNode::Text(t) => match out.last_mut() {
                Some(VNode::Text(prev)) => prev.push_str(&t),
                _ => out.push(VNode::Text(t)),
            },
            other => out.push(other),
        }
    }
    out
}

/// The state of one component instance. Instances are never reused: a
/// destroyed instance stays reachable from closures that captured it (as a
/// JavaScript closure keeps its component's state alive), but is no longer
/// rendered.
pub struct Instance<'p> {
    pub component: usize,
    pub cells: Vec<Val>,
    /// The committed state of the last flush (replaced, never mutated, so
    /// closures can keep the snapshot of their render).
    snapshot: Rc<Vec<Val>>,
    /// The snapshot before the last commit (what cleanups read under
    /// `cleanupReadsPrevious`).
    previous: Rc<Vec<Val>>,
    /// Per cell: bumped by every write that changes the value (tracked
    /// effects re-run after any such write, as signals notify).
    versions: Vec<u64>,
    /// The value each prop cell last received from the parent.
    passed: Vec<Option<Val>>,
    /// Two-way binding setters of prop cells.
    binds: Vec<Option<Val>>,
    /// Content the parent provides for each declared slot.
    slots: Vec<Option<Provided<'p>>>,
    alive: bool,
    /// The instance whose rendered output contains this one (the instance
    /// rendering a slot for content passed through it).
    parent: Option<usize>,
    effects: Vec<EffectState>,
    /// Cached derived values by function.
    derived: HashMap<usize, DerivedSlot>,
    /// Runs of the component's render effect (its re-renders).
    renders: u64,
    /// Effects created while the instance was created (`effect.pre`,
    /// `effect.post`), after the component's own: their metadata and run
    /// functions.
    dynamic: Vec<(Effect, Val)>,
    /// Contexts this instance set, by key.
    contexts: HashMap<String, Val>,
    /// Where context lookups continue: the parent, or for an imperatively
    /// mounted instance the instance whose contexts it was given (M6).
    context_parent: Option<usize>,
}

#[derive(Clone)]
struct DerivedSlot {
    value: Val,
    /// What its last computation read.
    reads: Vec<Read_>,
    heap: Vec<js::HeapRead>,
    /// Bumped when a recomputation gives a different value.
    version: u64,
}

impl std::fmt::Debug for DerivedSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "derived {:?}", self.value)
    }
}

/// A read of one key (or the size) of a keyed collection tracked as a
/// whole, while a tracked effect runs: the framework tracks keys one by one,
/// so the effect would re-run where the framework's does not.
const KEYED_READ: &str = "a keyed collection read by a tracked effect (the framework tracks one key; the program tracks the whole collection)";

/// An effect root (`effect.root`, Svelte's `$effect.root`, M6): effects
/// created while its function ran belong to it, not to an instance; they
/// run after the instances' effects in each flush pass until it is
/// destroyed (`effect.destroy-root`), which runs their cleanups in creation
/// order, then the cleanup its function returned.
struct RootScope {
    /// The instance its function ran in (the context its effects run in).
    current: usize,
    effects: Vec<(EffectPhase, Val)>,
    states: Vec<EffectState>,
    teardown: Option<Val>,
    alive: bool,
}

/// The run state of one effect of an instance.
#[derive(Default)]
struct EffectState {
    /// Dependencies are recorded (the effect is mounted).
    started: bool,
    /// Its last run changed what it read: due again (R4).
    rerun: bool,
    /// The effect whose run created this one (M6 overlays: bits-ui's
    /// `TimeoutFn` made in a `watch` callback): destroyed before that one
    /// runs again or is destroyed.
    parent: Option<usize>,
    /// Destroyed with its parent: never runs again.
    dead: bool,
    cleanup: Option<Val>,
    /// `values` dependencies of the last check.
    values: Vec<Val>,
    /// Reads of the last run (`tracked` dependencies).
    reads: Vec<Read_>,
    /// Heap objects the last run read.
    heap: Vec<js::HeapRead>,
}

/// A read recorded while a tracked effect or a derived value ran: a cell,
/// a derived value (`derived`, the function) of the instance, or a derived
/// class field (`field`: the object and field index, computed in
/// `instance` when its function belongs to a component).
#[derive(Clone)]
struct Read_ {
    instance: usize,
    cell: usize,
    derived: Option<usize>,
    field: Option<(js::WeakRef<RecordData>, usize)>,
    version: u64,
}

/// Slot content provided by a parent: its definition, the parent instance it
/// runs in and the parent's template locals where the child was rendered.
#[derive(Clone)]
struct Provided<'p> {
    parent: usize,
    def: &'p SlotDef,
    values: Vec<Val>,
}

/// Identity of a child instance: its parent instance, its `component` node and
/// the list keys on the path between them.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct InstKey {
    parent: usize,
    node: usize,
    path: Vec<MapKey>,
    /// Instances rendering the slots that contain the node.
    via: Vec<usize>,
}

/// A rendered listener: the handler with its instance and argument values.
#[derive(Clone)]
struct ListenerRef {
    instance: usize,
    handler: usize,
    args: Vec<Val>,
    /// A listener from an attribute bag: a function value called with the event.
    closure: Option<Val>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TimerKind {
    Timeout,
    Interval,
    Frame,
}

/// A queued microtask.
enum Micro {
    Call(Val),
    /// Run any pending flush now, then fulfil the promise (`flush.tick`).
    Tick(Promise),
    Promise(PJob),
    /// The flush job (see [`Schedule`]).
    Flush,
    /// Report the rejections a checkpoint left without a reaction (a
    /// default-priority task, as Chromium posts it; docs/IR.md, promises).
    Report(js::Rejections),
}

struct Timer {
    id: u64,
    kind: TimerKind,
    callback: Val,
    delay: f64,
    call_at: f64,
    created_at: f64,
}

/// `Date.now()` at virtual time 0 (2026-01-01T00:00:00Z), shared with the
/// probe and the browser harness's fake clock.
pub const CLOCK_ORIGIN: f64 = 1_767_225_600_000.0;

/// Virtual clock time when the program starts (as in the probe and the
/// browser harness, which pauses Playwright's clock 1000 ms after the origin).
pub const CLOCK_START: f64 = 1000.0;

pub struct Machine<'p> {
    pub program: &'p Program,
    /// Virtual time in milliseconds (`performance.now()`).
    now: f64,
    timers: Vec<Timer>,
    next_timer: u64,
    /// While a timer callback runs (zero delays then mean one tick).
    during_tick: bool,
    globals: Vec<Val>,
    instances: Vec<Instance<'p>>,
    /// Instances whose slot content is being rendered (innermost last).
    via: Vec<usize>,
    /// The instance whose cells expressions read and write.
    current: usize,
    payload: Option<Val>,
    /// The event of the running handler.
    event: Option<js::Event>,
    /// Element ids from the root to the element under the pointer.
    hovered: Vec<u64>,
    /// The focused element.
    focused: Option<u64>,
    /// An open select popup: the select and the highlighted option index.
    popup: Option<(u64, Option<usize>)>,
    /// The tree of the last render (what script sees between renders).
    last_tree: Vec<VNode>,
    /// Form identities remain known after removal, for disconnected receivers.
    known_forms: HashSet<u64>,
    /// Removed forms whose descendant controls could shadow requestSubmit.
    detached_shadowed_forms: HashSet<u64>,
    /// Same-form submission is suppressed until its listeners finish.
    submitting_forms: HashSet<u64>,
    /// Live values of uncontrolled text inputs (no `value` prop), by element id.
    live_values: HashMap<u64, String>,
    /// Live checked state of checkboxes, by element id.
    live_checked: HashMap<u64, bool>,
    /// The controlled `value` and `checked` last applied, by element id.
    control_cache: HashMap<u64, (Option<String>, Option<bool>)>,
    /// The re-render of its instance each `restore: render` control last applied.
    control_renders: HashMap<u64, u64>,
    /// The option value each `selectValue` select last showed.
    select_shown: HashMap<u64, String>,
    /// With `controlledRestore`: the next render restores controlled values
    /// (set at the mount, by flushes and after each dispatch that ran
    /// listeners, as the runtime syncs).
    restore_due: bool,
    /// Tasks run so far (event listeners, timers).
    tasks_run: u64,
    /// Class toggle state by element id: the class value, the toggles and
    /// the attribute they produced.
    class_states: HashMap<u64, (JsString, Vec<bool>, Option<JsString>)>,
    /// Managed inline style state by element id, with the attribute it produced.
    style_states: HashMap<u64, (runic_css::StyleState, Option<String>)>,
    /// The `defaultValue` a Svelte spread last assigned to a text control.
    spread_defaults: HashMap<u64, String>,
    /// The same in `replace` mode.
    replace_states: HashMap<u64, (runic_css::ReplaceState, Option<String>)>,
    /// The document element as scripts changed it.
    root: runic_css::Root,
    /// `<body>` as scripts change it (M6, bits-ui's scroll lock).
    body: runic_css::Root,
    /// What media queries see (the probe's default viewport and preferences).
    media: runic_css::MediaEnv,
    /// Document and window listeners in registration order: (window, kind, listener).
    host_listeners: Vec<(bool, EventKind, Val, u64)>,
    /// Capture listeners of the document and the window (M6 overlays:
    /// `on(document, "focusin", f, { capture: true })`), called before the
    /// event's path.
    capture_listeners: Vec<(bool, EventKind, Val, u64)>,
    /// Element listeners added by script (M6 overlays), after the
    /// template's listeners of their element.
    element_listeners: Vec<(u64, EventKind, Val, u64)>,
    /// Monotonic identity of each script listener registration, even when
    /// the same callback is removed and added again during dispatch.
    listener_registration: u64,
    /// Listeners of events of non-native types added by script (M6
    /// overlays), by element and type, in registration order.
    custom_listeners: Vec<(u64, JsString, Val)>,
    /// The visual viewport's listeners (M6 overlays).
    viewport_listeners: Vec<(EventKind, Val)>,
    /// MediaQueryList change listeners: each list (in creation order) with
    /// its listeners in registration order.
    media_lists: Vec<(js::MediaQueryList, Vec<Val>)>,
    children: HashMap<InstKey, usize>,
    /// Listeners of the last render, indexed by `VNode` listener ids.
    listeners: Vec<ListenerRef>,
    /// Capture listeners of elements by element id (attribute bag entries
    /// `on<event>capture`, M6 overlays): indices into `listeners`.
    capture_elements: HashMap<u64, Vec<(EventKind, usize)>>,
    /// Child instances in tree order (last render).
    order: Vec<usize>,
    /// Stable ids of rendered elements, by identity.
    element_ids: HashMap<(InstKey, usize), u64>,
    /// Elements rendered by the running render (an element that
    /// is not rendered loses its id: a remounted element is a new node).
    rendered_elements: HashSet<(InstKey, usize)>,
    /// The keys of every keyed list as last rendered (by instance, path and
    /// node), to know which blocks the framework moves.
    list_keys: HashMap<(usize, Vec<MapKey>, usize), Vec<MapKey>>,
    /// Elements of blocks the last render moved (Chromium blurs a focused
    /// element when it is detached to be moved).
    moved: HashSet<u64>,
    /// Radio buttons checked by the current render, in order.
    checked_radios: Vec<u64>,
    next_element: u64,
    /// Ref cells set by the last render: (instance, cell) → element id.
    refs: HashMap<(usize, usize), u64>,
    /// The snapshot `snapshot` reads use while a closure runs (otherwise the
    /// current instance's).
    snap: Option<Rc<Vec<Val>>>,
    microtasks: VecDeque<Micro>,
    /// Default-priority tasks (flush jobs queued outside events).
    default_tasks: VecDeque<Micro>,
    flush_pending: bool,
    /// While an input event is dispatched, including its microtask checkpoint.
    in_event: bool,
    /// While a discrete input event's listeners run (not its checkpoint).
    dispatching: bool,
    /// Heap mutation epochs at the last flush; mutations of tracked heap
    /// values queue a flush like cell writes.
    epochs: (u64, u64),
    tracks_deep: bool,
    tracks_owned: bool,
    /// Exceptions thrown by microtasks and default tasks (reported, as a
    /// browser reports uncaught errors, after the task).
    uncaught: Vec<Throw>,
    /// The record table for boxed values (M6 spike), made once.
    dyn_records: Option<Rc<Vec<crate::RecordType>>>,
    /// A runtime shape the model does not cover (`host.unsupported`): the
    /// step fails, as probes stop on it.
    unsupported: Option<String>,
    /// Cell reads of the running tracked effect.
    tracking: Option<Vec<Read_>>,
    /// The effect phase a running flush is in (writes then extend the flush).
    phase: Option<EffectPhase>,
    /// A write during the flush asks for another pass.
    again: bool,
    /// While a flush renders: which instances updated (pre effects run as
    /// each instance is rendered, after it received its props).
    render_updates: Option<Vec<bool>>,
    /// Function objects of stable closures, by (instance, function).
    stable_fns: HashMap<(Option<usize>, usize), Val>,
    /// While a cleanup runs under `cleanupReadsPrevious`.
    reading_previous: bool,
    version_clock: u64,
    /// The promise `flush.after` handed out for the pending flush.
    flush_promise: Option<Promise>,
    /// Effect roots (`effect.root`) and those whose functions are running.
    roots: Vec<RootScope>,
    root_stack: Vec<usize>,
    /// A tracked effect runs (not a derived value it reads): keyed reads
    /// tracked as a whole are reported (`reactive.keyed-read`).
    in_effect: bool,
    /// localStorage items in insertion order.
    storage: Vec<(JsString, JsString)>,
    /// Host services in probe mode (docs/design/M5-PLATFORM.md).
    host: HostState,
    /// Attachment keys created so far (each bag `attach` item makes one).
    attachment_keys: u64,
    /// Ids `uid.next` handed out so far.
    uids: u64,
    /// The instance whose cells are being initialised (effects and contexts
    /// created now belong to it).
    creating: Option<usize>,
    /// The instance effects running (innermost last): effects created there
    /// are their children.
    running: Vec<(usize, usize)>,
    /// Attachments applied to rendered elements: per element, the bag key,
    /// the function, its cleanup once it ran, and the instance rendering it.
    attached: HashMap<u64, Vec<Attached>>,
    /// Cleanups of attachments the last render removed (run after it).
    detached: Vec<Val>,
    /// Elements the running render rendered.
    rendered_ids: HashSet<u64>,
    /// Imperatively mounted instances in mount order (M6): the handle and
    /// the instance. They render after the root, as the body's last
    /// children.
    mounted: Vec<(Rc<std::cell::Cell<Option<usize>>>, usize)>,
    /// How many top-level nodes of the last tree the root rendered (the
    /// rest is mounted content in the body).
    root_len: usize,
    /// Nodes script created (M6 script DOM, docs/design/M6-SCRIPT-DOM.md).
    script: ScriptDom,
    /// Elements the last render rendered from template elements without
    /// children (rule O3a): script owns their child lists.
    script_hosts: HashSet<u64>,
}

/// The interpreter's nodes created by script (M6 script DOM): an arena
/// beside the rendered tree, whose element ids it never shares.
#[derive(Default)]
struct ScriptDom {
    nodes: HashMap<u64, ScriptNode>,
    next: u64,
    /// Script nodes in the body before the container, in order.
    preceding: Vec<u64>,
    /// The children script placed in rendered elements without template
    /// children, by element id.
    hosts: HashMap<u64, Vec<u64>>,
    /// Attributes script wrote on rendered elements (slice 2), by element
    /// id: the value script left (none: removed) and the framework's value
    /// when it last wrote it. A render writing a changed framework value
    /// that differs from script's is unsupported, as natively.
    attrs: HashMap<u64, BTreeMap<String, (Option<String>, Option<String>)>>,
}

struct ScriptNode {
    kind: ScriptKind,
    parent: Option<ScriptParent>,
    children: Vec<u64>,
}

enum ScriptKind {
    Element {
        tag: String,
        attrs: BTreeMap<String, String>,
    },
    Text(String),
    /// Slice 2: comments (left out of snapshots, as the harness leaves
    /// them out) and document fragments (never inserted themselves).
    Comment(String),
    Fragment,
}

#[derive(Clone, Copy, PartialEq)]
enum ScriptParent {
    Node(u64),
    /// A rendered element (rule O3a).
    Host(u64),
    /// The body, before the container.
    Body,
}

/// The first id of script-created nodes (rendered elements count up from 1).
const SCRIPT_IDS: u64 = 1 << 48;
/// The container as a node handle in the interpreter (the body's child
/// after the script nodes placed before it).
const CONTAINER: js::Element = js::Element(u64::MAX - 5);

impl ScriptDom {
    fn create(&mut self, kind: ScriptKind) -> u64 {
        let id = SCRIPT_IDS + self.next;
        self.next += 1;
        self.nodes.insert(
            id,
            ScriptNode {
                kind,
                parent: None,
                children: vec![],
            },
        );
        id
    }

    fn is_script(&self, id: u64) -> bool {
        self.nodes.contains_key(&id)
    }

    /// The node as the snapshot shows it (none for a comment or fragment).
    fn vnode(&self, id: u64) -> Option<VNode> {
        let n = &self.nodes[&id];
        match &n.kind {
            ScriptKind::Text(t) => Some(VNode::Text(t.clone())),
            ScriptKind::Element { tag, attrs } => Some(VNode::Element {
                tag: tag.clone(),
                attrs: attrs.clone(),
                value: None,
                checked: None,
                id,
                listeners: vec![],
                children: n.children.iter().filter_map(|&c| self.vnode(c)).collect(),
            }),
            ScriptKind::Comment(_) | ScriptKind::Fragment => None,
        }
    }

    /// The nodes `ids` as inserted: a fragment stands for its children.
    fn expand(&self, ids: &[u64]) -> Vec<u64> {
        let mut out = vec![];
        for &id in ids {
            match self.nodes.get(&id).map(|n| &n.kind) {
                Some(ScriptKind::Fragment) => out.extend(self.nodes[&id].children.iter().copied()),
                _ => out.push(id),
            }
        }
        out
    }

    /// A deep or shallow copy of script node `id` (script's own, detached).
    fn clone_node(&mut self, id: u64, deep: bool) -> u64 {
        let kind = match &self.nodes[&id].kind {
            ScriptKind::Element { tag, attrs } => ScriptKind::Element {
                tag: tag.clone(),
                attrs: attrs.clone(),
            },
            ScriptKind::Text(t) => ScriptKind::Text(t.clone()),
            ScriptKind::Comment(t) => ScriptKind::Comment(t.clone()),
            ScriptKind::Fragment => ScriptKind::Fragment,
        };
        let copy = self.create(kind);
        if deep {
            for c in self.nodes[&id].children.clone() {
                let cc = self.clone_node(c, true);
                self.insert(ScriptParent::Node(copy), cc, None);
            }
        }
        copy
    }

    /// A script copy of a rendered node (`cloneNode` of the framework's).
    fn adopt(&mut self, n: &VNode, deep: bool) -> u64 {
        match n {
            VNode::Text(t) => self.create(ScriptKind::Text(t.clone())),
            VNode::Element {
                tag,
                attrs,
                children,
                ..
            } => {
                let copy = self.create(ScriptKind::Element {
                    tag: tag.clone(),
                    attrs: attrs.clone(),
                });
                if deep {
                    for c in children {
                        let cc = self.adopt(c, true);
                        self.insert(ScriptParent::Node(copy), cc, None);
                    }
                }
                copy
            }
        }
    }

    fn list_mut(&mut self, parent: ScriptParent) -> &mut Vec<u64> {
        match parent {
            ScriptParent::Node(p) => &mut self.nodes.get_mut(&p).expect("script node").children,
            ScriptParent::Host(h) => self.hosts.entry(h).or_default(),
            ScriptParent::Body => &mut self.preceding,
        }
    }

    fn detach(&mut self, id: u64) {
        if let Some(parent) = self.nodes.get_mut(&id).and_then(|n| n.parent.take()) {
            self.list_mut(parent).retain(|&c| c != id);
        }
    }

    /// Insert `id` into `parent`'s child list before `before` (appended
    /// without one).
    fn insert(&mut self, parent: ScriptParent, id: u64, before: Option<u64>) {
        self.detach(id);
        let list = self.list_mut(parent);
        let at = before
            .and_then(|b| list.iter().position(|&c| c == b))
            .unwrap_or(list.len());
        list.insert(at, id);
        self.nodes.get_mut(&id).expect("script node").parent = Some(parent);
    }

    /// Whether `ancestor` is `id` or one of its script ancestors.
    fn inclusive_ancestor(&self, ancestor: u64, id: u64) -> bool {
        let mut at = Some(id);
        while let Some(n) = at {
            if n == ancestor {
                return true;
            }
            at = match self.nodes.get(&n).and_then(|x| x.parent) {
                Some(ScriptParent::Node(p)) => Some(p),
                _ => None,
            };
        }
        false
    }

    /// The outermost script ancestor's parent of `id` (where its tree is
    /// attached), if any.
    fn attachment(&self, id: u64) -> Option<ScriptParent> {
        let mut at = id;
        loop {
            match self.nodes.get(&at)?.parent? {
                ScriptParent::Node(p) => at = p,
                other => return Some(other),
            }
        }
    }

    fn text(&self, id: u64) -> String {
        match &self.nodes[&id].kind {
            ScriptKind::Text(t) => t.clone(),
            // (textContent of a comment is its data; inside an element it
            // contributes nothing.)
            ScriptKind::Comment(t) => t.clone(),
            ScriptKind::Element { .. } | ScriptKind::Fragment => self.nodes[&id]
                .children
                .iter()
                .filter(|c| !matches!(self.nodes[c].kind, ScriptKind::Comment(_)))
                .map(|&c| self.text(c))
                .collect(),
        }
    }
}

use js::BOOLEAN_PROPERTIES;

/// An attachment of a rendered element (docs/IR.md "Attribute bags").
struct Attached {
    key: String,
    function: Val,
    /// Set once the attachment ran (it runs with its instance's post effects).
    cleanup: Option<Option<Val>>,
    owner: usize,
}

/// The environment a probe starts with (the case manifest's `storage`,
/// `clipboard`, `url` and `seed`), kept across a `reload` except randomness.
#[derive(Clone, Debug)]
pub struct Env {
    pub storage: Vec<(JsString, JsString)>,
    pub clipboard: JsString,
    pub session: js::history::Session,
    pub seed: u64,
}

impl Default for Env {
    fn default() -> Self {
        Env {
            storage: vec![],
            clipboard: JsString::new(),
            session: js::history::Session::new("/").expect("start URL"),
            seed: 1,
        }
    }
}

/// Work the host does between tasks: clipboard replies, history
/// traversals and `hashchange` dispatches, in order.
enum HostTask {
    ClipboardWrite(JsString, Promise),
    ClipboardRead(Promise),
    Traverse(i64),
    HashChange,
    /// `host.reply`: fulfils its promise.
    Reply(Promise),
}

struct HostState {
    /// Console lines since the last snapshot: (level, text).
    console: Vec<(&'static str, JsString)>,
    clipboard: JsString,
    session: js::history::Session,
    random: js::random::SplitMix64,
    seed: u64,
    tasks: VecDeque<HostTask>,
    /// `document.title` (M6), empty when the document starts.
    title: JsString,
}

/// A string as snapshot JSON: text, or its code units when it holds a lone
/// surrogate (the browser harness encodes such console text the same way).
pub fn text_json(s: &JsString) -> Json {
    match String::from_utf16(s.units()) {
        Ok(t) => json!(t),
        Err(_) => json!({ "units": s.units() }),
    }
}

/// A clipboard holds text: lone surrogates become U+FFFD (as in Chromium).
fn well_formed(s: &JsString) -> JsString {
    JsString::from(s.to_rust())
}

/// Converts a capture to a match array element: `string | undefined`, or
/// `string` where the program declares every capture present (`ty` is
/// the declared `maybe<array<…>>`).
fn capture_conversion(ty: &Type) -> fn(Maybe<JsString>) -> Res<Val> {
    let strings = matches!(ty, Type::Maybe(a) if **a == Type::array(Type::String));
    if strings {
        |c| js::regexp::present(c).map(Val::Str)
    } else {
        |c| Ok(Val::from_maybe(c.map_val(Val::Str)))
    }
}

/// The exception an Error record value stands for.
fn throw_of(v: &Val) -> Throw {
    match v {
        Val::Record(r) => {
            let r = r.borrow();
            Throw {
                name: r.fields[0].string(),
                message: r.fields[1].string(),
            }
        }
        other => panic!("validated error record, found {other:?}"),
    }
}

/// `order` (parent first) with every instance after its children.
fn post_order(order: &[usize], instances: &[Instance<'_>]) -> Vec<usize> {
    fn visit(i: usize, order: &[usize], instances: &[Instance<'_>], out: &mut Vec<usize>) {
        for &c in order {
            if instances[c].parent == Some(i) {
                visit(c, order, instances, out);
            }
        }
        out.push(i);
    }
    let mut out = vec![];
    for &r in order {
        if !instances[r].parent.is_some_and(|p| order.contains(&p)) {
            visit(r, order, instances, &mut out);
        }
    }
    out
}

/// Whether any component has a cell with `tracking`.
fn cells_tracked(program: &Program, tracking: Tracking) -> bool {
    program
        .components
        .iter()
        .any(|c| c.cells.iter().any(|cell| cell.tracking == tracking))
}

fn throw_diag(t: Throw) -> Diagnostic {
    Diagnostic::new("E_THROW", t.to_string(), None)
}

impl<'p> Machine<'p> {
    pub fn new(program: &'p Program) -> Result<Self> {
        Self::with_storage(program, vec![])
    }

    /// localStorage items, in insertion order.
    pub fn storage(&self) -> Vec<(JsString, JsString)> {
        self.storage.clone()
    }

    /// A machine whose localStorage starts with `storage`.
    pub fn with_storage(program: &'p Program, storage: Vec<(JsString, JsString)>) -> Result<Self> {
        Self::with_env(
            program,
            Env {
                storage,
                ..Env::default()
            },
        )
    }

    /// The environment to start the same program again on (`reload`): the
    /// storage, clipboard and session history persist, and the session
    /// starts a new document at its current entry.
    pub fn reload_env(&self) -> Env {
        let mut session = self.host.session.clone();
        session.start_document();
        Env {
            storage: self.storage.clone(),
            clipboard: self.host.clipboard.clone(),
            session,
            seed: self.host.seed,
        }
    }

    /// A machine started in environment `env`.
    pub fn with_env(program: &'p Program, env: Env) -> Result<Self> {
        // Rejections of an earlier run are not this one's.
        js::clear_rejections();
        let Env {
            storage,
            clipboard,
            session,
            seed,
        } = env;
        let mut m = Machine {
            program,
            now: CLOCK_START,
            timers: vec![],
            next_timer: 1_000_000_000_000,
            during_tick: false,
            globals: vec![],
            instances: vec![],
            via: vec![],
            element_ids: HashMap::new(),
            rendered_elements: HashSet::new(),
            list_keys: HashMap::new(),
            moved: HashSet::new(),
            checked_radios: vec![],
            next_element: 0,
            refs: HashMap::new(),
            current: 0,
            payload: None,
            event: None,
            hovered: vec![],
            focused: None,
            popup: None,
            last_tree: vec![],
            known_forms: HashSet::new(),
            detached_shadowed_forms: HashSet::new(),
            submitting_forms: HashSet::new(),
            live_values: HashMap::new(),
            live_checked: HashMap::new(),
            control_cache: HashMap::new(),
            control_renders: HashMap::new(),
            select_shown: HashMap::new(),
            restore_due: true,
            tasks_run: 0,
            class_states: HashMap::new(),
            style_states: HashMap::new(),
            spread_defaults: HashMap::new(),
            replace_states: HashMap::new(),
            host_listeners: vec![],
            capture_listeners: vec![],
            element_listeners: vec![],
            listener_registration: 0,
            custom_listeners: vec![],
            viewport_listeners: vec![],
            media_lists: vec![],
            root: runic_css::Root::with_attrs(
                program
                    .document
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.as_str())),
            ),
            body: runic_css::Root::with_attrs(
                program.body.iter().map(|(k, v)| (k.as_str(), v.as_str())),
            ),
            media: runic_css::MediaEnv::default(),
            children: HashMap::new(),
            listeners: vec![],
            capture_elements: HashMap::new(),
            order: vec![],
            snap: None,
            microtasks: VecDeque::new(),
            default_tasks: VecDeque::new(),
            flush_pending: false,
            in_event: false,
            dispatching: false,
            epochs: (js::mutation_epoch(), js::owned_epoch()),
            tracks_deep: cells_tracked(program, Tracking::Deep),
            // Reactive class fields hold proxied deep state, read and written as proxies are.
            tracks_owned: cells_tracked(program, Tracking::Proxied)
                || program.has_reactive_fields(),
            uncaught: vec![],
            dyn_records: None,
            unsupported: None,
            tracking: None,
            phase: None,
            again: false,
            render_updates: None,
            stable_fns: HashMap::new(),
            reading_previous: false,
            version_clock: 0,
            flush_promise: None,
            roots: Vec::new(),
            root_stack: Vec::new(),
            in_effect: false,
            storage,
            host: HostState {
                console: vec![],
                clipboard,
                session,
                random: js::random::SplitMix64::new(seed),
                seed,
                tasks: VecDeque::new(),
                title: JsString::new(),
            },
            attachment_keys: 0,
            uids: 0,
            creating: None,
            running: Vec::new(),
            attached: HashMap::new(),
            detached: vec![],
            rendered_ids: HashSet::new(),
            mounted: vec![],
            root_len: 0,
            script: ScriptDom::default(),
            script_hosts: HashSet::new(),
        };
        for g in &program.globals {
            let v = m.eval(&g.init, &Frame::new(0)).map_err(throw_diag)?;
            m.globals.push(v);
        }
        m.create(program.root, &[], None).map_err(throw_diag)?;
        m.mount()?;
        // The document has loaded; then the host's replies run.
        m.host.session.loaded();
        let mut run = Run::default();
        m.host_tasks(&mut run);
        match run.error {
            Some(d) => Err(d),
            None => Ok(m),
        }
    }

    /// Create an instance of `component` with the props passed by its parent
    /// (`(cell, value, bind)`); returns its id.
    fn create(
        &mut self,
        component: usize,
        props: &[(usize, Val, Option<Val>)],
        parent: Option<usize>,
    ) -> Res<usize> {
        self.create_in(component, props, parent, parent, &[])
    }

    /// `create` with the instance where its context lookups continue and
    /// the content provided for its slots (before its initialisers run).
    fn create_in(
        &mut self,
        component: usize,
        props: &[(usize, Val, Option<Val>)],
        parent: Option<usize>,
        context_parent: Option<usize>,
        slots: &[Option<Provided<'p>>],
    ) -> Res<usize> {
        let comp = &self.program.components[component];
        let id = self.instances.len();
        let n = comp.cells.len();
        self.instances.push(Instance {
            component,
            cells: Vec::with_capacity(n),
            snapshot: Rc::new(vec![]),
            previous: Rc::new(vec![]),
            versions: vec![0; n],
            passed: vec![None; n],
            binds: vec![None; n],
            slots: vec![None; comp.slots.len()],
            alive: true,
            parent,
            effects: comp
                .effects
                .iter()
                .map(|_| EffectState::default())
                .collect(),
            derived: HashMap::new(),
            renders: 0,
            dynamic: vec![],
            contexts: HashMap::new(),
            context_parent,
        });
        if !slots.is_empty() {
            self.instances[id].slots = slots.to_vec();
        }
        let saved = std::mem::replace(&mut self.current, id);
        let creating = self.creating.replace(id);
        let result = (|| -> Res<()> {
            for (i, cell) in comp.cells.iter().enumerate() {
                let passed = props.iter().find(|(c, _, _)| *c == i);
                let v = match passed {
                    // Undefined takes the prop's default (Svelte's $props()).
                    Some((_, Val::Undefined, _)) if cell.undefined_default => {
                        self.eval(&cell.init, &Frame::new(0))?
                    }
                    Some((_, Val::Null, _))
                        if cell.undefined_default && !matches!(cell.ty, Type::Maybe(_)) =>
                    {
                        return Err(null_prop(&cell.name));
                    }
                    Some((_, v, _)) => v.clone(),
                    // Initial proxied state is proxied (props are passed as is).
                    None if cell.tracking == Tracking::Proxied && cell.prop.is_none() => {
                        js::Own::own(self.eval(&cell.init, &Frame::new(0))?)
                    }
                    None if cell.tracking == Tracking::Deep => {
                        let v = self.eval(&cell.init, &Frame::new(0))?;
                        js::Own::mark(&v);
                        v
                    }
                    None => self.eval(&cell.init, &Frame::new(0))?,
                };
                if let Err(d) = check_domain(cell, &v) {
                    return Err(Throw::new("RunicDomainError", d.message));
                }
                let inst = &mut self.instances[id];
                if let Some((_, v, b)) = passed {
                    inst.passed[i] = Some(v.clone());
                    inst.binds[i] = b.clone();
                }
                inst.cells.push(v);
                inst.snapshot = Rc::new(inst.cells.clone());
                inst.previous = inst.snapshot.clone();
            }
            Ok(())
        })();
        self.current = saved;
        self.creating = creating;
        result?;
        // Pre effects run when their instance is created.
        for e in 0..self.program.components[component].effects.len() {
            if self.program.components[component].effects[e].phase == EffectPhase::Pre {
                self.check_effect(id, e);
            }
        }
        Ok(id)
    }

    fn inst(&self) -> &Instance<'p> {
        &self.instances[self.current]
    }

    fn comp(&self) -> &'p Component {
        &self.program.components[self.instances[self.current].component]
    }

    /// Cells of the root instance.
    pub fn cells(&self) -> &[Val] {
        &self.instances[0].cells
    }

    // Expressions ---------------------------------------------------------------

    fn eval(&mut self, e: &Expr, f: &Frame) -> Res<Val> {
        use Expr::*;
        let v = match e {
            Lit { value } => Val::from_literal(value),
            Undefined { .. } => Val::Undefined,
            Null { .. } => Val::Null,
            Cell {
                cell,
                read: Read::Current,
            } => {
                let v = match &self.reading_previous {
                    true => self.inst().previous[*cell].clone(),
                    false => self.inst().cells[*cell].clone(),
                };
                let reactive = self.comp().cells[*cell].tracking != Tracking::None;
                if let (Some(reads), true) = (&mut self.tracking, reactive) {
                    reads.push(Read_ {
                        instance: self.current,
                        cell: *cell,
                        derived: None,
                        field: None,
                        version: self.instances[self.current].versions[*cell],
                    });
                }
                v
            }
            Cell {
                cell,
                read: Read::Snapshot,
            } => match &self.snap {
                Some(snap) => snap[*cell].clone(),
                None => self.inst().snapshot[*cell].clone(),
            },
            Global { global } => self.globals[*global].clone(),
            Local { local } => f.get(*local),
            Payload => self.payload.clone().expect("payload context"),
            Event => Val::Event(self.event.clone().expect("event context")),
            Attrs { items, merge } => {
                let mut out = vec![];
                for item in items {
                    match item {
                        AttrItem::Spread { spread } => {
                            if let Val::Attrs(b) = self.eval(spread, f)? {
                                if *merge {
                                    for (n, v) in resolve_attrs(&b) {
                                        merge_attr(&mut out, n.to_owned(), v.clone());
                                    }
                                } else {
                                    out.extend(b.iter().cloned());
                                }
                            }
                        }
                        AttrItem::Entry { name, value } => {
                            let v = self.eval(value, f)?;
                            if *merge {
                                merge_attr(&mut out, name.clone(), v);
                            } else {
                                out.push((name.clone(), v));
                            }
                        }
                        // An attachment under a key of its own (a fresh symbol).
                        AttrItem::Attach { attach } => {
                            let v = self.eval(attach, f)?;
                            self.attachment_keys += 1;
                            out.push((format!("{}{}", js::ATTACHMENT, self.attachment_keys), v));
                        }
                    }
                }
                Val::Attrs(Rc::new(out))
            }
            SlotProvided { name } => {
                let decl = self.comp().slot(name).expect("validated slot");
                Val::Bool(self.inst().slots[decl].is_some())
            }
            Mount {
                site,
                target,
                props,
                context,
            } => self.mount_site(*site, target, props, context.as_deref(), f)?,
            Not { arg } => Val::Bool(!self.eval(arg, f)?.boolean()),
            Neg { arg } => Val::Num(-self.eval(arg, f)?.num()),
            BitNot { arg } => Val::Num(js::bit_not(self.eval(arg, f)?.num())),
            ToString { arg } => {
                let v = self.eval(arg, f)?;
                // (Dynamic values convert with the shared semantics, which can
                // throw; a static array never holds them.)
                fn holds_dyn(v: &Val, depth: usize) -> bool {
                    match v {
                        Val::DynObject(_) | Val::Boxed(_) | Val::DynFn(_) => true,
                        Val::Array(a) if depth < 32 => {
                            a.borrow().iter().any(|x| holds_dyn(x, depth + 1))
                        }
                        _ => false,
                    }
                }
                if holds_dyn(&v, 0) {
                    Val::Str(runic_js::dynamic::to_string(&v)?)
                } else {
                    Val::Str(js::ToJsString::to_js_string(&v))
                }
            }
            ToNumber { arg } => Val::Num(js::ToNumber::to_number(&self.eval(arg, f)?)),
            ToBoolean { arg } => Val::Bool(js::Truthy::truthy(&self.eval(arg, f)?)),
            Typeof { arg } => Val::Str(JsString::from(js::TypeOf::type_of(&self.eval(arg, f)?))),
            Utf16Length { arg } => Val::Num(self.eval(arg, f)?.string().len() as f64),
            Add { left, right } => self.num2(left, right, f, |a, b| a + b)?,
            Sub { left, right } => self.num2(left, right, f, |a, b| a - b)?,
            Mul { left, right } => self.num2(left, right, f, |a, b| a * b)?,
            Div { left, right } => self.num2(left, right, f, |a, b| a / b)?,
            Rem { left, right } => self.num2(left, right, f, js::rem)?,
            Pow { left, right } => self.num2(left, right, f, js::pow)?,
            Min { left, right } => self.num2(left, right, f, js::min)?,
            Max { left, right } => self.num2(left, right, f, js::max)?,
            BitAnd { left, right } => self.num2(left, right, f, js::bit_and)?,
            BitOr { left, right } => self.num2(left, right, f, js::bit_or)?,
            BitXor { left, right } => self.num2(left, right, f, js::bit_xor)?,
            Shl { left, right } => self.num2(left, right, f, js::shl)?,
            Shr { left, right } => self.num2(left, right, f, js::shr)?,
            Ushr { left, right } => self.num2(left, right, f, js::ushr)?,
            Concat { left, right } => Val::Str(
                self.eval(left, f)?
                    .string()
                    .concat(&self.eval(right, f)?.string()),
            ),
            Eq { left, right } => {
                Val::Bool(strict_equal(&self.eval(left, f)?, &self.eval(right, f)?))
            }
            Ne { left, right } => {
                Val::Bool(!strict_equal(&self.eval(left, f)?, &self.eval(right, f)?))
            }
            Lt { left, right } => self.cmp(left, right, f, |a, b| a < b)?,
            Le { left, right } => self.cmp(left, right, f, |a, b| a <= b)?,
            Gt { left, right } => self.cmp(left, right, f, |a, b| a > b)?,
            Ge { left, right } => self.cmp(left, right, f, |a, b| a >= b)?,
            And { left, right } => {
                Val::Bool(self.eval(left, f)?.boolean() && self.eval(right, f)?.boolean())
            }
            Or { left, right } => {
                Val::Bool(self.eval(left, f)?.boolean() || self.eval(right, f)?.boolean())
            }
            Nullish { left, right } => match self.eval(left, f)? {
                Val::Undefined | Val::Null => self.eval(right, f)?,
                v => v,
            },
            Cond {
                test,
                then,
                otherwise,
            } => {
                if self.eval(test, f)?.boolean() {
                    self.eval(then, f)?
                } else {
                    self.eval(otherwise, f)?
                }
            }
            Mapped {
                guard,
                fast,
                reference,
                ..
            } => {
                if self.eval(guard, f)?.boolean() {
                    self.eval(fast, f)?
                } else {
                    self.eval(reference, f)?
                }
            }
            Record { record, fields } => {
                let mut given = fields
                    .iter()
                    .map(|x| self.eval(x, f))
                    .collect::<Res<Vec<_>>>()?
                    .into_iter();
                // Derived class fields have no value until read; `$state`
                // fields proxy plain objects and arrays.
                let rec = &self.program.records[*record];
                let values = rec
                    .fields
                    .iter()
                    .map(|fd| match fd.reactive {
                        Option::Some(Reactive::Derived) => Val::Undefined,
                        Option::Some(Reactive::State) => {
                            js::Own::own(given.next().expect("validated field"))
                        }
                        _ => given.next().expect("validated field"),
                    })
                    .collect();
                Val::Record(JsRef::new(RecordData::new(*record, values, rec.class)))
            }
            Array { items, .. } => {
                let mut out = vec![];
                for item in items {
                    match item {
                        ArrayItem::Item(x) => out.push(self.eval(x, f)?),
                        ArrayItem::Spread { spread } => {
                            out.extend(self.eval(spread, f)?.array().borrow().iter().cloned())
                        }
                    }
                }
                Val::Array(js::array(out))
            }
            Get { object, field } => match self.eval(object, f)? {
                Val::Record(r) => {
                    let reactive = self.program.records[r.peek().record].fields[*field].reactive;
                    match reactive {
                        Option::None => r.read_slot(*field as u32).fields[*field].clone(),
                        Option::Some(Reactive::Derived) => self.read_derived_field(&r, *field)?,
                        Option::Some(_) => r.read_signal(*field as u32).fields[*field].clone(),
                    }
                }
                other => panic!("validated record, found {other:?}"),
            },
            Index { array, index } => {
                let a = self.eval(array, f)?.array();
                let i = self.eval(index, f)?.num();
                js::array_ops::get_checked(&a, i)?
            }
            Some { value } => self.eval(value, f)?,
            Optional { value, local, then } => match self.eval(value, f)? {
                Val::Undefined | Val::Null => Val::Undefined,
                v => {
                    f.set(*local, v);
                    self.eval(then, f)?
                }
            },
            // Class references are instance records carrying their class.
            Upcast { value, .. } => self.eval(value, f)?,
            // A union value is its member's value (M6 unions); a downcast
            // checks the member it holds.
            Downcast { value, ty } if union_target(ty, self.program).is_some() => {
                let v = self.eval(value, f)?;
                let want = union_target(ty, self.program).expect("union downcast");
                if !matches!(v, Val::Undefined | Val::Null) && !want.iter().any(|m| val_is(&v, m)) {
                    return Err(Throw::type_error(union_message(&v, want)));
                }
                v
            }
            MatchUnion {
                value,
                cases,
                otherwise,
            } => {
                let v = self.eval(value, f)?;
                match cases.iter().find(|c| val_is(&v, &c.ty)) {
                    Option::Some(c) => {
                        f.set(c.local, v.clone());
                        self.eval(&c.body, f)?
                    }
                    Option::None => {
                        self.eval(otherwise.as_deref().expect("validated match-union"), f)?
                    }
                }
            }
            Downcast { value, ty } => {
                let v = self.eval(value, f)?;
                if let Val::Record(r) = &v {
                    let actual = r.peek().record;
                    let target = match ty {
                        Type::Maybe(t) => &**t,
                        t => t,
                    };
                    if !self
                        .program
                        .class_members(target)
                        .is_some_and(|m| m.contains(&actual))
                    {
                        return Err(Throw::type_error(
                            self.program.downcast_message(actual, target),
                        ));
                    }
                }
                v
            }
            MatchClass {
                value,
                cases,
                otherwise,
            } => {
                let v = self.eval(value, f)?;
                let Val::Record(r) = &v else {
                    panic!("validated class reference, found {v:?}");
                };
                let actual = r.peek().record;
                match cases.iter().find(|c| c.record == actual) {
                    Option::Some(c) => {
                        f.set(c.local, v.clone());
                        self.eval(&c.body, f)?
                    }
                    Option::None => {
                        self.eval(otherwise.as_deref().expect("validated match-class"), f)?
                    }
                }
            }
            Unwrap { value } => match self.eval(value, f)? {
                Val::Undefined => {
                    return Err(Throw::type_error("Cannot read properties of undefined"));
                }
                Val::Null => return Err(Throw::type_error("Cannot read properties of null")),
                v => v,
            },
            Call { function, args } if self.program.functions[*function].derived => {
                debug_assert!(args.is_empty());
                self.read_derived(self.current, *function)?
            }
            Call { function, args } => {
                let values = args
                    .iter()
                    .map(|a| self.eval(a, f))
                    .collect::<Res<Vec<_>>>()?;
                self.call(*function, vec![], values)?
            }
            CallValue { callee, args } => {
                let c = self.eval(callee, f)?;
                let values = args
                    .iter()
                    .map(|a| self.eval(a, f))
                    .collect::<Res<Vec<_>>>()?;
                self.call_value(&c, values)?
            }
            Closure {
                function,
                captures,
                stable,
            } => {
                let target = &self.program.functions[*function];
                let owner = target.component.map(|_| self.current);
                if *stable {
                    if let Some(v) = self.stable_fns.get(&(owner, *function)) {
                        return Ok(v.clone());
                    }
                }
                let captures = captures
                    .iter()
                    .zip(&target.captures)
                    .map(|(&c, l)| {
                        if l.boxed {
                            f.binding(c)
                        } else {
                            Rc::new(RefCell::new(f.get(c)))
                        }
                    })
                    .collect();
                let v = Val::Closure(Rc::new(self::Closure {
                    function: *function,
                    captures,
                    instance: owner,
                    snapshot: target.component.map(|_| self.current_snapshot()),
                }));
                if *stable {
                    self.stable_fns.insert((owner, *function), v.clone());
                }
                v
            }
            Builtin { name, args, ty } => {
                let values = args
                    .iter()
                    .map(|a| self.eval(a, f))
                    .collect::<Res<Vec<_>>>()?;
                let types: Vec<Type> = args.iter().map(|a| self.type_of(a, f)).collect();
                // (A script DOM operation on the framework's nodes, which the
                // interpreter does not hold, stops the run as an unsupported
                // shape does: the trace is incomplete, never a mismatch.)
                self.builtin(name, values, &types, ty).inspect_err(|t| {
                    let m = t.message.to_rust();
                    if t.name.to_rust() == "RunicLayoutError"
                        && (m.contains("native DOM") || m.contains("before the container only"))
                    {
                        self.unsupported.get_or_insert(m);
                    }
                })?
            }
            With { local, value, body } => {
                let v = self.eval(value, f)?;
                f.set(*local, v);
                self.eval(body, f)?
            }
        };
        Ok(v)
    }

    /// Static type of a builtin argument (needed only for JSON/structuredClone).
    fn type_of(&self, e: &Expr, _f: &Frame) -> Type {
        match e {
            Expr::Builtin { ty, .. } | Expr::Array { ty, .. } => ty.clone(),
            Expr::Record { record, .. } => Type::Record(*record),
            Expr::Cell { cell, .. } => self.comp().cells[*cell].ty.clone(),
            _ => Type::Void,
        }
    }

    fn num2(&mut self, l: &Expr, r: &Expr, f: &Frame, op: impl Fn(f64, f64) -> f64) -> Res<Val> {
        let a = self.eval(l, f)?.num();
        let b = self.eval(r, f)?.num();
        Ok(Val::Num(op(a, b)))
    }

    fn cmp(&mut self, l: &Expr, r: &Expr, f: &Frame, op: impl Fn(f64, f64) -> bool) -> Res<Val> {
        let a = self.eval(l, f)?.num();
        let b = self.eval(r, f)?.num();
        Ok(Val::Bool(op(a, b)))
    }

    /// Call function `index` with captured cells and arguments.
    fn call(&mut self, index: usize, captures: Vec<Rc<RefCell<Val>>>, args: Vec<Val>) -> Res<Val> {
        let func = &self.program.functions[index];
        let frame = Frame::new(func.local_count());
        for (i, c) in captures.into_iter().enumerate() {
            frame.locals.borrow_mut()[i] = c;
        }
        for (i, a) in args.into_iter().enumerate() {
            frame.set(func.captures.len() + i, a);
        }
        match self.exec_block(&func.body, &frame)? {
            Flow::Return(v) => Ok(v),
            _ => Ok(Val::Undefined),
        }
    }

    fn call_value(&mut self, callee: &Val, args: Vec<Val>) -> Res<Val> {
        if let Val::Resolver(r) = callee {
            if !r.done.replace(true) {
                let v = args.into_iter().next().unwrap_or(Val::Undefined);
                if r.reject {
                    self.settle_promise(&r.promise, Err(throw_of(&v)));
                } else {
                    self.resolve_promise(&r.promise, v);
                }
            }
            return Ok(Val::Undefined);
        }
        // Composed listeners: each in turn, none once the event is cancelled.
        if let Val::Listeners(list) = callee {
            for h in list.iter() {
                if let Some(Val::Event(e)) = args.first() {
                    if e.default_prevented() {
                        break;
                    }
                }
                self.call_value(h, args.clone())?;
            }
            return Ok(Val::Undefined);
        }
        if let Val::DynFn(adapter) = callee {
            return self.call_adapter(adapter, args);
        }
        let Val::Closure(c) = callee else {
            panic!("validated closure")
        };
        let func = &self.program.functions[c.function];
        let mut args = args;
        args.truncate(func.params.len());
        while args.len() < func.params.len() {
            args.push(Val::Undefined);
        }
        let saved = self.current;
        let saved_snap = self.snap.clone();
        if let Some(i) = c.instance {
            self.current = i;
            self.snap = c.snapshot.clone();
        }
        let r = self.call(c.function, c.captures.clone(), args);
        self.current = saved;
        self.snap = saved_snap;
        r
    }

    fn bump(&mut self, instance: usize, cell: usize) {
        self.version_clock += 1;
        self.instances[instance].versions[cell] = self.version_clock;
    }

    /// A ref cell set or cleared while rendering: a write that the running
    /// flush handles in another pass (outside a flush, the next flush sees it).
    /// A ref that is a bound prop (`bind:ref` on the component) forwards
    /// its element to the parent, as any write to the prop does.
    fn forward_ref(&mut self, instance: usize, cell: usize, v: Val) -> Res<()> {
        if let Some(bind) = self.instances[instance].binds[cell].clone() {
            self.call_value(&bind, vec![v])?;
        }
        Ok(())
    }

    fn ref_changed(&mut self, instance: usize, cell: usize) {
        self.bump(instance, cell);
        if self.phase.is_some() {
            self.again = true;
        }
    }

    /// Whether a recorded read is out of date; a derived value is brought up
    /// to date first (it changed only if its value did).
    fn read_changed(&mut self, r: &Read_) -> bool {
        if let Some((object, field)) = &r.field {
            // A collected object changes nothing any more.
            let Some(object) = object.upgrade() else {
                return true;
            };
            let saved = std::mem::replace(&mut self.current, r.instance);
            let refreshed = self.refresh_derived_field(&object, *field);
            self.current = saved;
            if refreshed.is_err() {
                return true;
            }
            return object
                .peek()
                .derived
                .get(field)
                .is_none_or(|d| d.version != r.version);
        }
        match r.derived {
            Some(f) => {
                if self.refresh_derived(r.instance, f).is_err() {
                    return true;
                }
                self.instances[r.instance]
                    .derived
                    .get(&f)
                    .is_none_or(|d| d.version != r.version)
            }
            None => {
                // Deep state changes through the heap objects that were read.
                self.instances[r.instance].versions[r.cell] != r.version
            }
        }
    }

    /// Recompute derived value `f` of instance `inst` if what it read changed;
    /// it keeps its value (and version) when the result is the same.
    fn refresh_derived(&mut self, inst: usize, f: usize) -> Res<()> {
        let stale = match self.instances[inst].derived.get(&f) {
            None => true,
            Some(d) => {
                let reads = d.reads.clone();
                d.heap.iter().any(js::HeapRead::changed)
                    || reads.iter().any(|r| self.read_changed(r))
            }
        };
        if !stale {
            return Ok(());
        }
        let outer = self.tracking.replace(vec![]);
        let heap_outer = js::begin_heap_reads(Some(self.tracks_owned));
        let saved = std::mem::replace(&mut self.current, inst);
        let saved_snap = self.snap.take();
        let effect_outer = std::mem::replace(&mut self.in_effect, false);
        let result = self.call(f, vec![], vec![]);
        self.in_effect = effect_outer;
        self.current = saved;
        self.snap = saved_snap;
        let heap = js::end_heap_reads(heap_outer);
        let reads = std::mem::replace(&mut self.tracking, outer).unwrap_or_default();
        let value = result?;

        let same = self.instances[inst].derived.get(&f).is_some_and(|d| {
            if self.program.functions[f].derived_strict {
                strict_equal(&d.value, &value)
            } else {
                d.value.same(&value)
            }
        });
        if same {
            let slot = self.instances[inst].derived.get_mut(&f).expect("slot");
            slot.reads = reads;
            slot.heap = heap;
        } else {
            self.version_clock += 1;
            let version = self.version_clock;
            self.instances[inst].derived.insert(
                f,
                DerivedSlot {
                    value,
                    reads,
                    heap,
                    version,
                },
            );
        }
        Ok(())
    }

    /// Recompute derived class field `field` of `object` if it was never
    /// computed or what it read changed (docs/IR.md, "Reactive class
    /// fields"); a result `===` to the cached value keeps it and its version.
    /// Its function runs in the current instance when it belongs to a component.
    fn refresh_derived_field(&mut self, object: &JsRef<RecordData>, field: usize) -> Res<()> {
        let cached = object.peek().derived.get(&field).cloned();
        let stale = match cached {
            None => true,
            Some(d) => {
                d.heap.iter().any(js::HeapRead::changed) || {
                    let mut any = false;
                    for r in &d.reads {
                        if self.read_changed(r) {
                            any = true;
                            break;
                        }
                    }
                    any
                }
            }
        };
        if !stale {
            return Ok(());
        }
        let function = self.program.records[object.peek().record].fields[field]
            .derived
            .expect("validated derived field");
        let outer = self.tracking.replace(vec![]);
        let heap_outer = js::begin_heap_reads(Some(self.tracks_owned));
        let saved_snap = self.snap.take();
        let effect_outer = std::mem::replace(&mut self.in_effect, false);
        let result = self.call(function, vec![], vec![Val::Record(object.clone())]);
        self.in_effect = effect_outer;
        self.snap = saved_snap;
        let heap = js::end_heap_reads(heap_outer);
        let reads = std::mem::replace(&mut self.tracking, outer).unwrap_or_default();
        let value = result?;
        let mut data = object.peek_mut();
        match data.derived.get_mut(&field) {
            Some(slot) if strict_equal(&slot.value, &value) => {
                slot.reads = reads;
                slot.heap = heap;
            }
            _ => {
                self.version_clock += 1;
                data.derived.insert(
                    field,
                    DerivedSlot {
                        value,
                        reads,
                        heap,
                        version: self.version_clock,
                    },
                );
            }
        }
        Ok(())
    }

    /// The value of derived class field `field` of `object` (a dependency of
    /// a running tracked computation).
    fn read_derived_field(&mut self, object: &JsRef<RecordData>, field: usize) -> Res<Val> {
        self.refresh_derived_field(object, field)?;
        let (value, version) = {
            let data = object.peek();
            let d = &data.derived[&field];
            (d.value.clone(), d.version)
        };
        if let Some(reads) = &mut self.tracking {
            reads.push(Read_ {
                instance: self.current,
                cell: 0,
                derived: None,
                field: Some((object.downgrade(), field)),
                version,
            });
        }
        Ok(value)
    }

    /// The value of derived `f` of `inst` (a dependency of a running tracked effect).
    fn read_derived(&mut self, inst: usize, f: usize) -> Res<Val> {
        self.refresh_derived(inst, f)?;
        let d = &self.instances[inst].derived[&f];
        let (value, version) = (d.value.clone(), d.version);
        if let Some(reads) = &mut self.tracking {
            reads.push(Read_ {
                instance: inst,
                cell: 0,
                derived: Some(f),
                field: None,
                version,
            });
        }
        Ok(value)
    }

    /// The snapshot `snapshot` reads see in the running code.
    fn current_snapshot(&self) -> Rc<Vec<Val>> {
        self.snap
            .clone()
            .unwrap_or_else(|| self.inst().snapshot.clone())
    }

    // Statements ----------------------------------------------------------------

    fn exec_block(&mut self, body: &[Stmt], f: &Frame) -> Res<Flow> {
        for s in body {
            match self.exec(s, f)? {
                Flow::Normal => {}
                other => return Ok(other),
            }
        }
        Ok(Flow::Normal)
    }

    fn place_set(&mut self, p: &Place, v: Val, f: &Frame) -> Res<()> {
        match p {
            Place::Local { local } => f.set(*local, v),
            Place::Cell { cell } => self.set_cell(*cell, v)?,
            Place::Field { object, field } => match self.eval(object, f)? {
                Val::Record(r) => {
                    let reactive = self.program.records[r.peek().record].fields[*field].reactive;
                    match reactive {
                        // (A proxy's field already `===` the value: nothing
                        // changes, as in Svelte's sources.)
                        Option::None => {
                            let v = js::own_into(&r, v);
                            if !r.unchanged(*field as u32, |b| strict_equal(&b.fields[*field], &v))
                            {
                                r.write_slots(&[*field as u32]).fields[*field] = v
                            }
                        }
                        // A reactive class field: `$state` proxies plain objects
                        // and arrays; a value `===` the old one changes nothing.
                        Option::Some(kind) => {
                            let v = if kind == Reactive::State {
                                js::Own::own(v)
                            } else {
                                v
                            };
                            if !strict_equal(&r.peek().fields[*field], &v) {
                                r.write_signal(*field as u32).fields[*field] = v;
                                self.queue_flush();
                            }
                        }
                    }
                }
                other => panic!("validated record, found {other:?}"),
            },
            Place::Index { array, index } => {
                let a = self.eval(array, f)?.array();
                let i = self.eval(index, f)?.num();
                let v = js::own_into(&a, v);
                let same = js::array_ops::element_index(i).is_some_and(|k| {
                    a.unchanged(k as u32 + 1, |b| {
                        b.get(k).is_some_and(|x| strict_equal(x, &v))
                    })
                });
                if !same {
                    js::array_ops::set(&a, i, v)?;
                }
            }
        }
        Ok(())
    }

    fn set_cell(&mut self, cell: usize, v: Val) -> Res<()> {
        if let Err(d) = check_domain(&self.comp().cells[cell], &v) {
            return Err(Throw::new("RunicDomainError", d.message));
        }
        let current = self.current;
        // Proxied state stores proxies of plain objects and arrays.
        let v = match self.comp().cells[cell].tracking {
            Tracking::Proxied => js::Own::own(v),
            Tracking::Deep => {
                js::Own::mark(&v);
                v
            }
            _ => v,
        };
        if !self.instances[current].cells[cell].same(&v) {
            self.bump(current, cell);
        }
        self.instances[current].cells[cell] = v.clone();
        self.queue_flush();
        // A bound prop forwards the write to the parent.
        if let Some(bind) = self.instances[current].binds[cell].clone() {
            self.call_value(&bind, vec![v])?;
        }
        Ok(())
    }

    fn exec(&mut self, s: &Stmt, f: &Frame) -> Res<Flow> {
        match s {
            Stmt::Set { cell, value, .. } => {
                let v = self.eval(value, f)?;
                self.set_cell(*cell, v)?;
            }
            Stmt::Let { local, value, .. } => {
                let v = match value {
                    Some(e) => self.eval(e, f)?,
                    None => Val::Undefined,
                };
                // A fresh binding per execution (closures capture the binding).
                f.rebind(*local, v);
            }
            Stmt::Assign { target, value, .. } => {
                let v = self.eval(value, f)?;
                self.place_set(target, v, f)?;
            }
            Stmt::Expr { value, .. } => {
                self.eval(value, f)?;
            }
            Stmt::If {
                test,
                then,
                otherwise,
                ..
            } => {
                let body = if self.eval(test, f)?.boolean() {
                    then
                } else {
                    otherwise
                };
                return self.exec_block(body, f);
            }
            Stmt::While {
                test,
                body,
                update,
                label,
            } => loop {
                if !self.eval(test, f)?.boolean() {
                    break;
                }
                match self.exec_block(body, f)? {
                    Flow::Break(l) if l.is_none() || l == *label => break,
                    Flow::Continue(l) if l.is_none() || l == *label => {}
                    Flow::Normal => {}
                    other => return Ok(other),
                }
                if let Flow::Return(v) = self.exec_block(update, f)? {
                    return Ok(Flow::Return(v));
                }
            },
            Stmt::ForOf {
                local,
                iterable,
                body,
                label,
                ..
            } => {
                let items: Vec<Val> = match self.eval(iterable, f)? {
                    Val::Array(a) => a.borrow().clone(),
                    Val::Set(s) => s.borrow().entries.values().cloned().collect(),
                    Val::Str(s) => js::string_ops::code_points(&s)
                        .into_iter()
                        .map(Val::Str)
                        .collect(),
                    other => panic!("validated iterable, found {other:?}"),
                };
                for item in items {
                    f.rebind(*local, item);
                    match self.exec_block(body, f)? {
                        Flow::Break(l) if l.is_none() || l == *label => break,
                        Flow::Continue(l) if l.is_none() || l == *label => {}
                        Flow::Normal => {}
                        other => return Ok(other),
                    }
                }
            }
            Stmt::Break { label } => return Ok(Flow::Break(label.clone())),
            Stmt::Continue { label } => return Ok(Flow::Continue(label.clone())),
            Stmt::Return { value, .. } => {
                let v = match value {
                    Some(e) => self.eval(e, f)?,
                    None => Val::Undefined,
                };
                return Ok(Flow::Return(v));
            }
            Stmt::Throw { value, .. } => {
                let v = self.eval(value, f)?;
                let Val::Record(r) = v else {
                    panic!("validated error record")
                };
                let r = r.borrow();
                return Err(Throw {
                    name: r.fields[0].string(),
                    message: r.fields[1].string(),
                });
            }
            Stmt::Try {
                body,
                catch,
                finally,
            } => {
                let result = match self.exec_block(body, f) {
                    Ok(flow) => Ok(flow),
                    Err(t) => match catch {
                        Some(c) => {
                            if let Some(l) = c.local {
                                let record = self.error_record();
                                f.set(
                                    l,
                                    Val::Record(JsRef::new(RecordData::new(
                                        record,
                                        vec![Val::Str(t.name), Val::Str(t.message)],
                                        false,
                                    ))),
                                );
                            }
                            self.exec_block(&c.body, f)
                        }
                        None => Err(t),
                    },
                };
                if let Some(fin) = finally {
                    match self.exec_block(fin, f)? {
                        Flow::Normal => {}
                        other => return Ok(other),
                    }
                }
                return result;
            }
        }
        Ok(Flow::Normal)
    }

    fn error_record(&self) -> usize {
        self.program
            .records
            .iter()
            .position(validate::is_error_record)
            .expect("validated error record")
    }

    // Built-ins -----------------------------------------------------------------

    fn callback(&mut self, f: &Val, args: Vec<Val>) -> Res<Val> {
        self.call_value(f, args)
    }

    fn builtin(&mut self, name: &str, a: Vec<Val>, types: &[Type], ty: &Type) -> Res<Val> {
        if let Some(m) = name.strip_prefix("dyn.") {
            return self.dyn_builtin(m, a, types, ty);
        }
        // Items inserted into a proxied array become proxies.
        let inserted = match name {
            "array.push" | "array.unshift" => 1..usize::MAX,
            "array.fill" => 1..2,
            "array.splice" => 3..usize::MAX,
            _ => 0..0,
        };
        // (or are marked reactive in a reactive array).
        let a: Vec<Val> = match (a.first().cloned(), inserted.is_empty()) {
            (Some(Val::Array(r)), false) => a
                .into_iter()
                .enumerate()
                .map(|(i, v)| {
                    if inserted.contains(&i) {
                        js::own_into(&r, v)
                    } else {
                        v
                    }
                })
                .collect(),
            _ => a,
        };
        use js::array_ops as arr;
        use js::string_ops as st;
        let n = |i: usize| a[i].num();
        let s = |i: usize| a[i].string();
        let opt_n = |i: usize| a.get(i).map_or(Maybe::Undefined, Val::maybe_num);
        let opt_s = |i: usize| a.get(i).map_or(Maybe::Undefined, Val::maybe_str);
        let nums = |from: usize| a[from..].iter().map(Val::num).collect::<Vec<_>>();
        let (ns, method) = name.split_once('.').unwrap_or(("", name));
        let v = match (ns, method) {
            ("Math", "min-of") => Val::Num(js::math::min_of(&a[0].array())),
            ("Math", "max-of") => Val::Num(js::math::max_of(&a[0].array())),
            ("Math", "hypot-of") => Val::Num(js::math::hypot_of(&a[0].array())),
            ("Math", m) => Val::Num(math(m, &nums(0))),
            ("Number", "MAX_SAFE_INTEGER") => Val::Num(9007199254740991.0),
            ("Number", "MIN_SAFE_INTEGER") => Val::Num(-9007199254740991.0),
            ("Number", "EPSILON") => Val::Num(f64::EPSILON),
            ("Number", "MAX_VALUE") => Val::Num(f64::MAX),
            ("Number", "MIN_VALUE") => Val::Num(5e-324),
            ("Number", "POSITIVE_INFINITY") => Val::Num(f64::INFINITY),
            ("Number", "NEGATIVE_INFINITY") => Val::Num(f64::NEG_INFINITY),
            ("Number", "NaN") => Val::Num(f64::NAN),
            ("Number", "isNaN") => Val::Bool(n(0).is_nan()),
            ("Number", "isFinite") => Val::Bool(n(0).is_finite()),
            ("Number", "isInteger") => Val::Bool(js::is_integer(n(0))),
            ("Number", "isSafeInteger") => Val::Bool(js::is_safe_integer(n(0))),
            ("Number", "parseFloat") | ("", "parseFloat") => Val::Num(js::parse_float(&s(0))),
            ("Number", "parseInt") | ("", "parseInt") => Val::Num(js::parse_int(&s(0), opt_n(1))),
            ("", "isNaN") => Val::Bool(js::ToNumber::to_number(&a[0]).is_nan()),
            ("", "isFinite") => Val::Bool(js::ToNumber::to_number(&a[0]).is_finite()),
            ("", "String") => Val::Str(
                a.first()
                    .map_or(JsString::new(), js::ToJsString::to_js_string),
            ),
            ("", "Number") => Val::Num(a.first().map_or(0.0, js::ToNumber::to_number)),
            ("", "Boolean") => Val::Bool(a.first().is_some_and(js::Truthy::truthy)),
            ("", "structuredClone") => self.clone_deep(&a[0]),
            ("number", "toFixed") => Val::Str(js::to_fixed(n(0), a.get(1).map_or(0.0, Val::num))?),
            ("number", "toString") => Val::Str(match a.get(1) {
                Some(r) => js::to_string_radix(n(0), r.num())?,
                None => js::ToJsString::to_js_string(&n(0)),
            }),
            ("number", "toPrecision") => Val::Str(js::to_precision(n(0), opt_n(1))?),
            ("number", "toExponential") => Val::Str(js::to_exponential(n(0), opt_n(1))?),
            ("date", "new") => Val::Date(js::Date::new(n(0))),
            ("date", "local" | "utc") => {
                let f = if method == "local" {
                    js::date::local_time_value
                } else {
                    js::date::utc_time_value
                };
                Val::Num(f(n(0), n(1), n(2), n(3), n(4), n(5), n(6)))
            }
            ("date", "parse") => Val::Num(js::date::parse(&s(0))),
            ("date", m) => {
                let Val::Date(d) = &a[0] else {
                    panic!("validated Date")
                };
                let tv = d.time();
                match m {
                    "getTime" => Val::Num(tv),
                    "toString" => Val::Str(js::date::to_string(tv)),
                    "toDateString" => Val::Str(js::date::to_date_string_local(tv)),
                    "toTimeString" => Val::Str(js::date::to_time_string(tv)),
                    "toUTCString" => Val::Str(js::date::to_utc_string(tv)),
                    "toISOString" => Val::Str(js::date::to_iso_string(tv)?),
                    "toJSON" => js::date::to_json(tv).map_or(Val::Null, Val::Str),
                    m if m.starts_with("set") => Val::Num(d.set(m, &nums(1))),
                    m => Val::Num(js::date::get(tv, m)),
                }
            }
            (
                "intl",
                m @ ("locale"
                | "plural-select"
                | "plural-categories"
                | "display-of"
                | "time-zone"
                | "format-date-runtime"),
            ) => {
                // A locale or value outside the verified data stops the
                // run (E_UNSUPPORTED), as the native runtime reports it.
                let result = (|| -> js::JsResult<Val> {
                    if m == "time-zone" {
                        return Ok(Val::Str(js::intl::default_time_zone()?));
                    }
                    if m == "format-date-runtime" {
                        return Ok(Val::Str(js::intl::format_date_runtime(n(0), &s(1), &s(2))?));
                    }
                    if m == "locale" {
                        let check = if s(1).to_rust() == "p" {
                            js::intl::check_plural_locale
                        } else {
                            js::intl::check_display_locale
                        };
                        check(&s(0))?;
                        return Ok(Val::Str(s(0)));
                    }
                    let operands = usize::from(m != "plural-categories");
                    let spec = s(operands).to_rust();
                    let locale = a.get(operands + 1).map(Val::string);
                    let locale = locale.as_ref();
                    Ok(match m {
                        "plural-select" => {
                            let spec = js::intl::PluralSpec::parse(&spec).expect("validated");
                            Val::Str(js::intl::plural_select(n(0), &spec, locale)?)
                        }
                        "plural-categories" => {
                            let spec = js::intl::PluralSpec::parse(&spec).expect("validated");
                            let list = js::intl::plural_categories(&spec, locale)?;
                            Val::Array(js::array(list.into_iter().map(Val::Str).collect()))
                        }
                        _ => {
                            let spec = js::intl::NamesSpec::parse(&spec).expect("validated");
                            js::intl::display_name(&s(0), &spec, locale)?
                                .map_or(Val::Undefined, Val::Str)
                        }
                    })
                })();
                match result {
                    Err(t) if t.name.to_rust() == "RunicUnsupportedError" => {
                        self.unsupported.get_or_insert(t.message.to_rust());
                        return Err(t);
                    }
                    r => r?,
                }
            }
            ("intl", m) => {
                let operands = if m == "compare" { 2 } else { 1 };
                let spec = s(operands);
                let locale = a.get(operands + 1).map(Val::string);
                let locale = locale.as_ref();
                match m {
                    "format-date" => {
                        let spec = js::intl::DateSpec::parse(&spec.to_rust()).expect("validated");
                        Val::Str(js::intl::format_date(n(0), &spec, locale)?)
                    }
                    "format-number" => {
                        let spec = js::intl::NumberSpec::parse(&spec.to_rust()).expect("validated");
                        Val::Str(js::intl::format_number(n(0), &spec, locale)?)
                    }
                    _ => {
                        let spec =
                            js::intl::CollatorSpec::parse(&spec.to_rust()).expect("validated");
                        Val::Num(js::intl::compare(&s(0), &s(1), &spec, locale)?)
                    }
                }
            }
            ("regexp", "new") => Val::RegExp(js::RegExp::new(&s(0), &s(1))?),
            ("regexp", m) => {
                let Val::RegExp(re) = &a[0] else {
                    panic!("validated RegExp")
                };
                let f = re.flags();
                match m {
                    "source" => Val::Str(re.source()),
                    "flags" => Val::Str(re.flags_string()),
                    "toString" => Val::Str(js::ToJsString::to_js_string(re)),
                    "global" => Val::Bool(f.global),
                    "ignoreCase" => Val::Bool(f.ignore_case),
                    "multiline" => Val::Bool(f.multiline),
                    "dotAll" => Val::Bool(f.dot_all),
                    "unicode" => Val::Bool(f.unicode),
                    "unicodeSets" => Val::Bool(f.unicode_sets),
                    "sticky" => Val::Bool(f.sticky),
                    "hasIndices" => Val::Bool(f.has_indices),
                    "lastIndex" => Val::Num(re.last_index()),
                    "set-lastIndex" => {
                        re.set_last_index(n(1));
                        Val::Undefined
                    }
                    "test" => Val::Bool(re.test(&s(1))),
                    "exec" => {
                        let conv = capture_conversion(ty);
                        Val::from_maybe(re.exec_with(&s(1), conv)?.map_val(Val::Array))
                    }
                    other => unreachable!("validated RegExp member {other}"),
                }
            }
            ("string", m) if m.starts_with("regexp-") => {
                let Val::RegExp(re) = &a[1] else {
                    panic!("validated RegExp")
                };
                let text = s(0);
                match m {
                    "regexp-replace" | "regexp-replaceAll" => match &a[2] {
                        Val::Str(t) => Val::Str(if m == "regexp-replace" {
                            js::regexp::replace(&text, re, t)
                        } else {
                            js::regexp::replace_all(&text, re, t)?
                        }),
                        f => {
                            let Val::Closure(c) = f else {
                                panic!("validated replacer")
                            };
                            let params: Vec<Type> = self.program.functions[c.function]
                                .params
                                .iter()
                                .map(|p| p.ty.clone())
                                .collect();
                            let f = f.clone();
                            let mut call =
                                |caps: &[Maybe<JsString>], pos: f64, input: &JsString| {
                                    let mut args = vec![];
                                    for (i, c) in caps.iter().enumerate() {
                                        // A capture declared present.
                                        if params.get(i) == Some(&Type::String) {
                                            js::regexp::present(c.clone())?;
                                        }
                                        args.push(Val::from_maybe(c.clone().map_val(Val::Str)));
                                    }
                                    args.push(Val::Num(pos));
                                    args.push(Val::Str(input.clone()));
                                    Ok(self.callback(&f, args)?.string())
                                };
                            Val::Str(if m == "regexp-replace" {
                                js::regexp::replace_with(&text, re, &mut call)?
                            } else {
                                js::regexp::replace_all_with(&text, re, &mut call)?
                            })
                        }
                    },
                    "regexp-match" => {
                        let conv = capture_conversion(ty);
                        Val::from_maybe(
                            js::regexp::match_with(&text, re, conv)?.map_val(Val::Array),
                        )
                    }
                    "regexp-matchAll" => {
                        let Type::Array(item) = ty else {
                            panic!("validated matchAll")
                        };
                        let all = js::regexp::match_all_with(
                            &text,
                            re,
                            capture_conversion(&Type::maybe((**item).clone())),
                        )?;
                        Val::Array(js::array(
                            all.borrow().iter().cloned().map(Val::Array).collect(),
                        ))
                    }
                    "regexp-search" => Val::Num(js::regexp::search(&text, re)),
                    "regexp-split" => {
                        let conv = capture_conversion(&Type::maybe(ty.clone()));
                        Val::Array(js::regexp::split_with(&text, re, opt_n(2), conv)?)
                    }
                    other => unreachable!("validated string method {other}"),
                }
            }
            ("match", m) => {
                let arr = a[0].array();
                match m {
                    "index" => Val::from_maybe(js::regexp::match_index(&arr).map_val(Val::Num)),
                    "input" => Val::from_maybe(js::regexp::match_input(&arr).map_val(Val::Str)),
                    "has-groups" => Val::Bool(js::regexp::match_has_groups(&arr)),
                    "group" => {
                        Val::from_maybe(js::regexp::match_group(&arr, &s(1))?.map_val(Val::Str))
                    }
                    other => unreachable!("validated match member {other}"),
                }
            }
            ("string", m) => {
                let r = s(0);
                match m {
                    "at" => Val::from_maybe(st::at(&r, n(1)).map_val(Val::Str)),
                    "index" => Val::from_maybe(st::index(&r, n(1)).map_val(Val::Str)),
                    "charAt" => Val::Str(st::char_at(&r, a.get(1).map_or(0.0, Val::num))),
                    "charCodeAt" => Val::Num(st::char_code_at(&r, a.get(1).map_or(0.0, Val::num))),
                    "codePointAt" => Val::from_maybe(
                        st::code_point_at(&r, a.get(1).map_or(0.0, Val::num)).map_val(Val::Num),
                    ),
                    "slice" => Val::Str(st::slice(&r, a.get(1).map_or(0.0, Val::num), opt_n(2))),
                    "substring" => {
                        Val::Str(st::substring(&r, a.get(1).map_or(0.0, Val::num), opt_n(2)))
                    }
                    "indexOf" => Val::Num(st::index_of(&r, &s(1), opt_n(2))),
                    "lastIndexOf" => Val::Num(st::last_index_of(&r, &s(1), opt_n(2))),
                    "includes" => Val::Bool(st::includes(&r, &s(1), opt_n(2))),
                    "startsWith" => Val::Bool(st::starts_with(&r, &s(1), opt_n(2))),
                    "endsWith" => Val::Bool(st::ends_with(&r, &s(1), opt_n(2))),
                    "trim" => Val::Str(st::trim(&r)),
                    "trimStart" => Val::Str(st::trim_start(&r)),
                    "trimEnd" => Val::Str(st::trim_end(&r)),
                    "toUpperCase" => Val::Str(st::to_upper_case(&r)),
                    "toLowerCase" => Val::Str(st::to_lower_case(&r)),
                    "toString" => Val::Str(r),
                    "padStart" => Val::Str(st::pad_start(&r, n(1), opt_s(2))),
                    "padEnd" => Val::Str(st::pad_end(&r, n(1), opt_s(2))),
                    "repeat" => Val::Str(st::repeat(&r, n(1))?),
                    "split" => {
                        let parts = st::split(&r, opt_s(1), opt_n(2));
                        Val::Array(js::array(
                            parts.borrow().iter().cloned().map(Val::Str).collect(),
                        ))
                    }
                    "replace" => Val::Str(st::replace(&r, &s(1), &s(2))),
                    "replaceAll" => Val::Str(st::replace_all(&r, &s(1), &s(2))),
                    "concat" => Val::Str(st::concat(
                        &r,
                        &a[1..].iter().map(Val::string).collect::<Vec<_>>(),
                    )),
                    "localeCompare" => Val::Num(st::locale_compare(&r, &s(1))),
                    "lt" => Val::Bool(st::compare(&r, &s(1)).is_lt()),
                    "le" => Val::Bool(st::compare(&r, &s(1)).is_le()),
                    "gt" => Val::Bool(st::compare(&r, &s(1)).is_gt()),
                    "ge" => Val::Bool(st::compare(&r, &s(1)).is_ge()),
                    other => unreachable!("validated string method {other}"),
                }
            }
            ("array", m) => {
                let r = a[0].array();
                let cb = a.get(1).cloned();
                match m {
                    "length" => Val::Num(arr::length(&r)),
                    "get" => Val::from_maybe(arr::get(&r, n(1))),
                    "at" => Val::from_maybe(arr::at(&r, n(1))),
                    "push" => Val::Num(arr::push(&r, a[1..].to_vec())),
                    "unshift" => Val::Num(arr::unshift(&r, a[1..].to_vec())),
                    "pop" => Val::from_maybe(arr::pop(&r)),
                    "shift" => Val::from_maybe(arr::shift(&r)),
                    "slice" => Val::Array(arr::slice(&r, opt_n(1), opt_n(2))),
                    "splice" => Val::Array(arr::splice(
                        &r,
                        n(1),
                        opt_n(2),
                        a.get(3..).map_or(vec![], <[Val]>::to_vec),
                    )),
                    "concat" => {
                        let args = a[1..]
                            .iter()
                            .zip(&types[1..])
                            .map(|(v, t)| {
                                if *t == types[0] {
                                    arr::ConcatArg::Array(v.array())
                                } else {
                                    arr::ConcatArg::Item(v.clone())
                                }
                            })
                            .collect();
                        Val::Array(arr::concat(&r, args))
                    }
                    "indexOf" => Val::Num(arr::index_of(&r, &a[1], opt_n(2))),
                    "lastIndexOf" => Val::Num(arr::last_index_of(&r, &a[1], opt_n(2))),
                    "includes" => Val::Bool(arr::includes(&r, &a[1], opt_n(2))),
                    "find" | "findLast" | "findIndex" | "findLastIndex" | "some" | "every"
                    | "filter" | "forEach" => {
                        let f = cb.expect("callback");
                        let arr_val = a[0].clone();
                        let mut pred = |x: &Val, i: f64| -> Res<bool> {
                            Ok(js::Truthy::truthy(&self.callback(
                                &f,
                                vec![x.clone(), Val::Num(i), arr_val.clone()],
                            )?))
                        };
                        match m {
                            "find" => Val::from_maybe(arr::find(&r, &mut pred)?),
                            "findLast" => Val::from_maybe(arr::find_last(&r, &mut pred)?),
                            "findIndex" => Val::Num(arr::find_index(&r, &mut pred)?),
                            "findLastIndex" => Val::Num(arr::find_last_index(&r, &mut pred)?),
                            "some" => Val::Bool(arr::some(&r, &mut pred)?),
                            "every" => Val::Bool(arr::every(&r, &mut pred)?),
                            "filter" => Val::Array(arr::filter(&r, &mut pred)?),
                            _ => {
                                arr::for_each(&r, |x, i| pred(x, i).map(|_| ()))?;
                                Val::Undefined
                            }
                        }
                    }
                    "map" | "flatMap" => {
                        let f = cb.expect("callback");
                        let arr_val = a[0].clone();
                        let mut g = |x: &Val, i: f64| {
                            self.callback(&f, vec![x.clone(), Val::Num(i), arr_val.clone()])
                        };
                        if m == "map" {
                            Val::Array(arr::map(&r, &mut g)?)
                        } else {
                            Val::Array(arr::flat_map(&r, |x, i| g(x, i).map(|v| v.array()))?)
                        }
                    }
                    "reduce" | "reduceRight" => {
                        let f = cb.expect("reducer");
                        let arr_val = a[0].clone();
                        let mut g = |acc: Val, x: &Val, i: f64| {
                            self.callback(&f, vec![acc, x.clone(), Val::Num(i), arr_val.clone()])
                        };
                        match (a.get(2), m) {
                            (Some(init), "reduce") => arr::reduce(&r, &mut g, init.clone())?,
                            (Some(init), _) => arr::reduce_right(&r, &mut g, init.clone())?,
                            (None, "reduce") => arr::reduce_first(&r, |acc, x, i| g(acc, x, i))?,
                            (None, _) => {
                                let reversed = arr::to_reversed(&r);
                                arr::reduce_first(&reversed, |acc, x, i| g(acc, x, i))?
                            }
                        }
                    }
                    "join" => Val::Str(arr::join(&r, opt_s(1))),
                    "reverse" => Val::Array(arr::reverse(&r)),
                    "toReversed" => Val::Array(arr::to_reversed(&r)),
                    "sort" | "toSorted" => {
                        let mut compare = |x: &Val, y: &Val| -> Res<f64> {
                            Ok(js::ToNumber::to_number(&self.callback(
                                cb.as_ref().unwrap(),
                                vec![x.clone(), y.clone()],
                            )?))
                        };
                        let cmp: Option<&mut dyn FnMut(&Val, &Val) -> Res<f64>> = if a.len() > 1 {
                            Some(&mut compare)
                        } else {
                            None
                        };
                        Val::Array(if m == "sort" {
                            arr::sort(&r, cmp)?
                        } else {
                            arr::to_sorted(&r, cmp)?
                        })
                    }
                    "with" => Val::Array(arr::with(&r, n(1), a[2].clone())?),
                    "fill" => Val::Array(arr::fill(&r, a[1].clone(), opt_n(2), opt_n(3))),
                    "flat" => {
                        let nested: JsArray<JsArray<Val>> =
                            js::array(r.borrow().iter().map(Val::array).collect());
                        Val::Array(arr::flat(&nested))
                    }
                    other => unreachable!("validated array method {other}"),
                }
            }
            ("Array", "from") => {
                let items: Vec<Val> = match &a[0] {
                    Val::Array(x) => x.borrow().clone(),
                    Val::Set(x) => x.borrow().entries.values().cloned().collect(),
                    Val::Str(x) => st::code_points(x).into_iter().map(Val::Str).collect(),
                    other => panic!("validated iterable, found {other:?}"),
                };
                match a.get(1) {
                    None => Val::Array(js::array(items)),
                    Some(f) => {
                        let mut out = vec![];
                        for (i, x) in items.into_iter().enumerate() {
                            out.push(self.callback(f, vec![x, Val::Num(i as f64)])?);
                        }
                        Val::Array(js::array(out))
                    }
                }
            }
            ("Array", "isArray") => Val::Bool(matches!(a[0], Val::Array(_))),
            ("Array", "of") => Val::Array(js::array(a.clone())),
            ("Map", "new") => match a.first() {
                Some(Val::Map(m)) => Val::Map(arr::map_new::<Val, Val>(
                    m.borrow().entries.values().cloned().collect(),
                )),
                _ => Val::Map(arr::map_new::<Val, Val>(vec![])),
            },
            ("Set", "new") => Val::Set(arr::set_new(
                a.first().map_or(vec![], |x| x.array().borrow().clone()),
            )),
            ("map", m) => {
                let Val::Map(map) = &a[0] else {
                    panic!("validated map")
                };
                match m {
                    "get" => Val::from_maybe(arr::map_get(map, &a[1])),
                    "set" => Val::Map(arr::map_set(map, a[1].clone(), a[2].clone())),
                    "has" => Val::Bool(arr::map_has(map, &a[1])),
                    "delete" => Val::Bool(arr::map_delete(map, &a[1])),
                    "clear" => {
                        arr::map_clear(map);
                        Val::Undefined
                    }
                    "size" => Val::Num(arr::map_size(map)),
                    "keys" => Val::Array(arr::map_keys(map)),
                    "values" => Val::Array(arr::map_values(map)),
                    "dictionary-keys" => {
                        Val::Array(arr::dictionary_keys(map, |k: &Val| k.string().to_rust()))
                    }
                    "dictionary-values" => {
                        Val::Array(arr::dictionary_values(map, |k: &Val| k.string().to_rust()))
                    }
                    "entries" => {
                        let Type::Array(e) = ty else {
                            panic!("validated entries")
                        };
                        let Type::Record(r) = **e else {
                            panic!("validated entries")
                        };
                        let keys = arr::map_keys(map);
                        let values = arr::map_values(map);
                        let items: Vec<Val> = keys
                            .borrow()
                            .iter()
                            .zip(values.borrow().iter())
                            .map(|(k, v)| {
                                Val::Record(JsRef::new(RecordData::new(
                                    r,
                                    vec![k.clone(), v.clone()],
                                    false,
                                )))
                            })
                            .collect();
                        Val::Array(js::array(items))
                    }
                    other => unreachable!("validated map method {other}"),
                }
            }
            ("set", m) => {
                let Val::Set(set) = &a[0] else {
                    panic!("validated set")
                };
                match m {
                    "add" => Val::Set(arr::set_add(set, a[1].clone())),
                    "has" => Val::Bool(arr::set_has(set, &a[1])),
                    "delete" => Val::Bool(arr::set_delete(set, &a[1])),
                    "clear" => {
                        arr::set_clear(set);
                        Val::Undefined
                    }
                    "size" => Val::Num(arr::set_size(set)),
                    "values" | "keys" => Val::Array(arr::set_values(set)),
                    other => unreachable!("validated set method {other}"),
                }
            }
            ("timer", "timeout") => self.add_timer(TimerKind::Timeout, a[0].clone(), a[1].num()),
            ("timer", "interval") => self.add_timer(TimerKind::Interval, a[0].clone(), a[1].num()),
            ("timer", "frame") => {
                let delay = 16.0 - self.now % 16.0;
                self.add_timer(TimerKind::Frame, a[0].clone(), delay)
            }
            ("timer", "clear") => {
                let id = a[0].num();
                self.timers.retain(|t| t.id as f64 != id);
                Val::Undefined
            }
            ("storage", "get") => match self.storage.iter().find(|(k, _)| *k == a[0].string()) {
                Some((_, v)) => Val::Str(v.clone()),
                None => Val::Null,
            },
            ("storage", "set") => {
                let (k, v) = (a[0].string(), a[1].string());
                match self.storage.iter_mut().find(|(x, _)| *x == k) {
                    Some((_, old)) => *old = v,
                    None => self.storage.push((k, v)),
                }
                Val::Undefined
            }
            ("storage", "remove") => {
                let k = a[0].string();
                self.storage.retain(|(x, _)| *x != k);
                Val::Undefined
            }
            ("storage", "clear") => {
                self.storage.clear();
                Val::Undefined
            }
            ("console", level) => {
                let level = match level {
                    "log" => "log",
                    "info" => "info",
                    "warn" => "warn",
                    "error" => "error",
                    _ => "debug",
                };
                let mut text: Vec<u16> = vec![];
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        text.push(u16::from(b' '));
                    }
                    text.extend_from_slice(js::ToJsString::to_js_string(v).units());
                }
                self.host.console.push((level, JsString::from_units(text)));
                Val::Undefined
            }
            ("clipboard", m) => {
                // Chromium settles overlapping operations in an order that
                // depends on their kinds, which the model does not cover.
                let pending = self.host.tasks.iter().any(|t| {
                    matches!(t, HostTask::ClipboardWrite(..) | HostTask::ClipboardRead(_))
                });
                if pending {
                    return Err(Throw::new(
                        "RunicHostError",
                        "a clipboard operation while another is pending",
                    ));
                }
                let p = Promise::pending();
                self.host.tasks.push_back(match m {
                    "write" => HostTask::ClipboardWrite(a[0].string(), p.clone()),
                    _ => HostTask::ClipboardRead(p.clone()),
                });
                Val::Promise(p)
            }
            ("history", m @ ("back" | "forward" | "go")) => {
                let delta = match m {
                    "back" => -1,
                    "forward" => 1,
                    _ => a[0].num() as i64,
                };
                if delta == 0 {
                    return Err(Throw::new(
                        "RunicHistoryError",
                        "history.go(0) reloads the page, which the model does not cover",
                    ));
                }
                self.traverse(delta)?;
                Val::Undefined
            }
            ("history", "push") => {
                let url = a.first().and_then(Val::as_string);
                let state = a.get(1).and_then(Val::as_string);
                self.host.session.push(url.as_ref(), state.as_ref())?;
                Val::Undefined
            }
            ("history", "replace") => {
                let url = a.first().and_then(Val::as_string);
                let state = a.get(1).and_then(Val::as_string);
                self.host.session.replace(url.as_ref(), state.as_ref())?;
                Val::Undefined
            }
            ("history", "state") => match self.host.session.state() {
                Some(s) => Val::Str(s),
                None => Val::Null,
            },
            // The document (M6).
            ("document", "title") => Val::Str(js::history::document_title(&self.host.title)),
            ("document", "set-title") => {
                self.host.title = a[0].string();
                Val::Undefined
            }
            ("document", "querySelector") => {
                let selector = js::parse_selector(&a[0].string().to_rust()).map_err(|m| {
                    Throw::new("RunicUnsupportedError", format!("querySelector: {m}"))
                })?;
                let preceding: Vec<VNode> = self
                    .script
                    .preceding
                    .iter()
                    .filter_map(|&c| self.script.vnode(c))
                    .collect();
                match document_query(&self.last_tree, self.root_len, &preceding, &selector)? {
                    Some(e) => Val::Element(js::Element(e)),
                    None => Val::Null,
                }
            }
            ("document", "getElementById") => {
                let id = a[0].string().to_rust();
                match element_by_id(&self.last_tree, &id) {
                    Some(e) => Val::Element(js::Element(e)),
                    None => Val::Null,
                }
            }
            ("focus", "current") => match self.focused {
                Some(e) => Val::Element(js::Element(e)),
                None => Val::Null,
            },
            // The router's focus reset: focus moves to the body (blurring
            // the focused element; the interpreter has no navigation order).
            ("focus", "reset") => {
                if self.focused.is_some() {
                    self.move_focus_nested(None);
                }
                Val::Undefined
            }
            // No sequential navigation order in the interpreter.
            ("focus", "start") => Val::Undefined,
            ("url", "resolve") => {
                match js::history::Session::resolve_against(&a[0].string(), &a[1].string()) {
                    Some(u) => Val::Str(JsString::from(u)),
                    None => Val::Undefined,
                }
            }
            ("url", "query-pairs") => {
                let pairs: Vec<Val> = js::uri::query_pairs(&a[0].string())
                    .into_iter()
                    .map(|(k, v)| Val::Array(js::array(vec![Val::Str(k), Val::Str(v)])))
                    .collect();
                Val::Array(js::array(pairs))
            }
            ("host", "reply") => {
                let p = Promise::pending();
                self.host.tasks.push_back(HostTask::Reply(p.clone()));
                Val::Promise(p)
            }
            ("host", "unsupported") => {
                let what = a[0].string().to_rust();
                self.unsupported.get_or_insert(what.clone());
                return Err(Throw::new("RunicUnsupportedError", what));
            }
            ("", "encodeURIComponent") => Val::Str(js::uri::encode_uri_component(&a[0].string())?),
            ("css", "escape") => Val::Str(js::string_ops::css_escape(&a[0].string())),
            ("", "decodeURIComponent") => Val::Str(js::uri::decode_uri_component(&a[0].string())?),
            ("", "decodeURI") => Val::Str(js::uri::decode_uri(&a[0].string())?),
            ("history", "length") => Val::Num(self.host.session.length() as f64),
            ("location", "pathname") => Val::Str(JsString::from(self.host.session.pathname())),
            ("location", "search") => Val::Str(JsString::from(self.host.session.search())),
            ("location", "hash") => Val::Str(JsString::from(self.host.session.hash())),
            ("location", "set-hash") => {
                if self.host.session.set_hash(&a[0].string())? {
                    // popstate at once (nested in the setter), hashchange as a task.
                    self.dispatch_window_nested(EventKind::Popstate);
                    self.host.tasks.push_back(HostTask::HashChange);
                }
                Val::Undefined
            }
            ("random", "number") => Val::Num(self.host.random.number()),
            ("random", "uuid") => Val::Str(JsString::from(self.host.random.uuid())),
            ("promise", m) => self.promise_builtin(m, a)?,
            ("flush", "tick") => {
                let p = Promise::pending();
                self.enqueue(Micro::Tick(p.clone()));
                Val::Promise(p)
            }
            ("flush", "after") => {
                if self.flush_pending || self.phase.is_some() {
                    Val::Promise(
                        self.flush_promise
                            .get_or_insert_with(Promise::pending)
                            .clone(),
                    )
                } else {
                    Val::Promise(Promise::fulfilled(Val::Undefined))
                }
            }
            ("microtask", "queue") => {
                self.queue_micro(a[0].clone());
                Val::Undefined
            }
            ("clock", "now") => Val::Num(self.now),
            ("clock", "date") => Val::Num(CLOCK_ORIGIN + self.now),
            // Focus has no interpreter observable (the snapshot has no focus).
            // focus() and blur() move focus at once; the focus listeners run
            // nested, before the call returns.
            // No layout here: such programs are compared against the browser
            // only (the differential reports them incomplete).
            _ if crate::builtins::needs_layout(name) => {
                return Err(Throw::new(
                    "RunicLayoutError",
                    format!("{name} needs the native layout, which the interpreter does not have"),
                ));
            }
            ("element", m @ ("nextElementSibling" | "previousElementSibling")) => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let chain = chain_nodes(&self.last_tree, e.0).unwrap_or_default();
                let split = self.root_len.min(self.last_tree.len());
                // The children of the parent, or the root's or the body's own.
                let siblings: &[VNode] = match chain.len().checked_sub(2).map(|i| chain[i]) {
                    Some(VNode::Element { children, .. }) => children,
                    _ if self.last_tree[..split]
                        .iter()
                        .any(|n| element_id(n) == Some(e.0)) =>
                    {
                        &self.last_tree[..split]
                    }
                    _ => &self.last_tree[split..],
                };
                let at = siblings
                    .iter()
                    .position(|n| element_id(n) == Some(e.0))
                    .unwrap_or(0);
                let found = if m == "nextElementSibling" {
                    siblings[at + 1..].iter().find_map(element_id)
                } else {
                    siblings[..at].iter().rev().find_map(element_id)
                };
                // (Before the first element mounted in the body: the container.)
                if found.is_none()
                    && m == "previousElementSibling"
                    && !self.last_tree[..split]
                        .iter()
                        .any(|n| element_id(n) == Some(e.0))
                    && chain.len() == 1
                {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        "a sibling that is not the program's (the container)",
                    ));
                }
                found.map_or(Val::Null, |n| Val::Element(js::Element(n)))
            }
            // (The interpreter's text nodes have no ids: a text node is
            // reported for `firstNonCommentNode` too.)
            ("element", "firstNonCommentChild" | "firstNonCommentNode") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let chain = chain_nodes(&self.last_tree, e.0).unwrap_or_default();
                match chain.last() {
                    Some(VNode::Element { children, .. }) => match children.first() {
                        Some(VNode::Element { id, .. }) => Val::Element(js::Element(*id)),
                        Some(VNode::Text(_)) => {
                            return Err(Throw::new(
                                "RunicUnsupportedError",
                                "the first child node is a text node (script values are elements)",
                            ));
                        }
                        None => Val::Null,
                    },
                    _ => Val::Null,
                }
            }
            // Script DOM (M6, docs/design/M6-SCRIPT-DOM.md): nodes script
            // created, and the child lists of rendered elements without
            // template children; the rendered tree itself needs the native
            // DOM (below).
            ("document", "node") => Val::Element(js::Element::DOCUMENT),
            ("window", "node") => Val::Element(js::Element::WINDOW),
            ("document", "createElement") => {
                let tag = a[0].string().to_rust().to_ascii_lowercase();
                Val::Element(js::Element(self.script.create(ScriptKind::Element {
                    tag,
                    attrs: BTreeMap::new(),
                })))
            }
            ("element", "setAttribute" | "removeAttribute" | "style-set-text")
                if self.script_element(&a[0]).is_some() =>
            {
                let id = self.script_element(&a[0]).expect("script element");
                let value = match name.split_once('.').map(|x| x.1) {
                    Some("style-set-text") => {
                        let css = a[1].string().to_rust();
                        if let Some(d) = runic_css::dropped_declaration(&css) {
                            let what = format!(
                                "style.cssText with {d}, which the style engine drops (Chromium keeps it)"
                            );
                            self.unsupported.get_or_insert(what.clone());
                            return Err(Throw::new("RunicUnsupportedError", what));
                        }
                        Some(("style".to_owned(), runic_css::css_text(&css)))
                    }
                    Some("setAttribute") => Some((
                        a[1].string().to_rust().to_ascii_lowercase(),
                        a[2].string().to_rust(),
                    )),
                    _ => None,
                };
                if let Some(ScriptKind::Element { attrs, .. }) =
                    self.script.nodes.get_mut(&id).map(|n| &mut n.kind)
                {
                    match value {
                        Some((k, v)) => {
                            attrs.insert(k, v);
                        }
                        None => {
                            attrs.remove(&a[1].string().to_rust().to_ascii_lowercase());
                        }
                    }
                }
                self.regraft();
                Val::Undefined
            }
            ("element", "insertBefore" | "appendChild") => {
                let method = name.split_once('.').map_or("", |x| x.1);
                let before = match (method, a.get(2)) {
                    ("insertBefore", Some(Val::Element(b))) => Some(*b),
                    _ => None,
                };
                let node = a[1].clone();
                self.script_insert(&a[0], &a[1], before, method)?;
                node
            }
            ("element", "replaceChildren") => {
                let Val::Array(items) = &a[1] else {
                    panic!("validated array")
                };
                let items: Vec<Val> = items.borrow().clone();
                let parent = self.script_parent(&a[0], "replaceChildren")?;
                for it in &items {
                    self.script_check_insert(parent, it, None, "replaceChildren")?;
                }
                if parent == ScriptParent::Body {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        "replaceChildren of the body (it holds the app's container)",
                    ));
                }
                for c in self.script.list_mut(parent).clone() {
                    self.script.detach(c);
                }
                for it in items {
                    let Val::Element(e) = it else { continue };
                    self.script.insert(parent, e.0, None);
                }
                self.regraft();
                Val::Undefined
            }
            ("element", "remove") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                if !self.script.is_script(e.0) {
                    return Err(Throw::new(
                        "RunicLayoutError",
                        "remove() of a rendered node needs the native DOM, which the interpreter does not have",
                    ));
                }
                self.script.detach(e.0);
                self.regraft();
                Val::Undefined
            }
            ("element", m @ ("set-textContent" | "set-innerText")) => {
                let text = a[1].string().to_rust();
                let parent = self.script_parent(&a[0], m)?;
                if parent == ScriptParent::Body {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        "textContent of the body (it holds the app)",
                    ));
                }
                // (A text node's data.)
                if let ScriptParent::Node(id) = parent {
                    if let ScriptKind::Text(t) | ScriptKind::Comment(t) =
                        &mut self.script.nodes.get_mut(&id).unwrap().kind
                    {
                        *t = text;
                        self.regraft();
                        return Ok(Val::Undefined);
                    }
                }
                for c in self.script.list_mut(parent).clone() {
                    self.script.detach(c);
                }
                let parts = if m == "set-innerText" {
                    js::script_dom::inner_text_parts(&text)
                } else if text.is_empty() {
                    vec![]
                } else {
                    vec![Some(text)]
                };
                for part in parts {
                    let kind = match part {
                        Some(t) => ScriptKind::Text(t),
                        None => ScriptKind::Element {
                            tag: "br".into(),
                            attrs: BTreeMap::new(),
                        },
                    };
                    let id = self.script.create(kind);
                    self.script.insert(parent, id, None);
                }
                self.regraft();
                Val::Undefined
            }
            // Slice 2: text, comment and fragment nodes; kinds, data and
            // traversal; the ChildNode/ParentNode insertions; cloning; classList.
            ("document", m @ ("createTextNode" | "createComment")) => {
                let data = a[0].string().to_rust();
                let kind = if m == "createComment" {
                    ScriptKind::Comment(data)
                } else {
                    ScriptKind::Text(data)
                };
                Val::Element(js::Element(self.script.create(kind)))
            }
            ("document", "createDocumentFragment") => {
                Val::Element(js::Element(self.script.create(ScriptKind::Fragment)))
            }
            ("element", m @ ("nodeType" | "nodeName" | "nodeValue")) => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                if *e == js::Element::WINDOW || *e == js::Element::VISUAL_VIEWPORT {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        format!("{m} of the window"),
                    ));
                }
                let (kind, name, value): (f64, String, Option<String>) = if *e
                    == js::Element::DOCUMENT
                {
                    (9.0, "#document".into(), None)
                } else if let Some(n) = self.script.nodes.get(&e.0) {
                    match &n.kind {
                        ScriptKind::Element { tag, .. } => (1.0, tag.to_ascii_uppercase(), None),
                        ScriptKind::Text(t) => (3.0, "#text".into(), Some(t.clone())),
                        ScriptKind::Comment(t) => (8.0, "#comment".into(), Some(t.clone())),
                        ScriptKind::Fragment => (11.0, "#document-fragment".into(), None),
                    }
                } else {
                    let tag =
                        match chain_nodes(&self.last_tree, e.0).and_then(|c| c.last().copied()) {
                            Some(VNode::Element { tag, .. }) => tag.clone(),
                            _ if *e == js::Element::BODY => "body".into(),
                            _ => {
                                return Err(Throw::new(
                                    "RunicUnsupportedError",
                                    format!("{m} of a node the interpreter does not hold"),
                                ));
                            }
                        };
                    let name = if crate::validate::SVG_TAGS.contains(&tag.as_str()) {
                        tag
                    } else {
                        tag.to_ascii_uppercase()
                    };
                    (1.0, name, None)
                };
                match m {
                    "nodeType" => Val::Num(kind),
                    "nodeName" => Val::Str(JsString::from(name.as_str())),
                    _ => value.map_or(Val::Null, |v| Val::Str(JsString::from(v.as_str()))),
                }
            }
            ("element", "set-nodeValue") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let text = a[1].string().to_rust();
                if let Some(n) = self.script.nodes.get_mut(&e.0) {
                    match &mut n.kind {
                        ScriptKind::Text(t) | ScriptKind::Comment(t) => *t = text,
                        _ => {}
                    }
                }
                self.regraft();
                Val::Undefined
            }
            ("element", m @ ("lastChild" | "nextSibling" | "previousSibling")) => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let (parent, list, at) = if m == "lastChild" {
                    if *e == js::Element::BODY {
                        return Err(Throw::new(
                            "RunicUnsupportedError",
                            "lastChild of the body (the browser's page has its own nodes after the container)",
                        ));
                    }
                    let p = self.script_parent(&a[0], m)?;
                    let list = self.script_list(p);
                    (p, list, None)
                } else if *e == CONTAINER {
                    let list = self.script_list(ScriptParent::Body);
                    (
                        ScriptParent::Body,
                        list.clone(),
                        list.iter().position(|&s| s == e.0),
                    )
                } else {
                    let Some((p, list)) = self.script_siblings(e.0) else {
                        if self.script.is_script(e.0) {
                            return Ok(Val::Null);
                        }
                        return Err(Throw::new(
                            "RunicUnsupportedError",
                            format!(
                                "{m} among the children of an element the framework renders children into"
                            ),
                        ));
                    };
                    let at = list.iter().position(|&s| s == e.0);
                    (p, list, at)
                };
                let found = match (m, at) {
                    ("lastChild", _) => list.last().copied(),
                    ("nextSibling", Some(i)) => list.get(i + 1).copied(),
                    ("previousSibling", Some(i)) if i > 0 => list.get(i - 1).copied(),
                    _ => None,
                };
                if parent == ScriptParent::Body && m != "previousSibling" && found.is_none() {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        format!("{m} past the app's container at the body"),
                    ));
                }
                found.map_or(Val::Null, |n| Val::Element(js::Element(n)))
            }
            ("element", "parentNode") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                if let Some(n) = self.script.nodes.get(&e.0) {
                    return Ok(match n.parent {
                        Some(ScriptParent::Node(p) | ScriptParent::Host(p)) => {
                            Val::Element(js::Element(p))
                        }
                        Some(ScriptParent::Body) => Val::Element(js::Element::BODY),
                        None => Val::Null,
                    });
                }
                let chain = chain_nodes(&self.last_tree, e.0).unwrap_or_default();
                match chain
                    .len()
                    .checked_sub(2)
                    .and_then(|i| element_id(chain[i]))
                {
                    Some(p) => Val::Element(js::Element(p)),
                    None if chain.is_empty() => Val::Null,
                    None => {
                        return Err(Throw::new(
                            "RunicUnsupportedError",
                            "parentNode of a top-level element (the container is not the program's)",
                        ));
                    }
                }
            }
            ("element", m @ ("childNodes" | "children")) => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let ids: Vec<u64> = if m == "children" && !self.script.is_script(e.0) {
                    match chain_nodes(&self.last_tree, e.0).and_then(|c| c.last().copied()) {
                        Some(VNode::Element { children, .. }) => {
                            children.iter().filter_map(element_id).collect()
                        }
                        _ => {
                            return Err(Throw::new(
                                "RunicUnsupportedError",
                                format!("{m} of a node the interpreter does not hold"),
                            ));
                        }
                    }
                } else {
                    if *e == js::Element::BODY {
                        return Err(Throw::new(
                            "RunicUnsupportedError",
                            format!(
                                "{m} of the body (the browser's page has its own nodes after the container)"
                            ),
                        ));
                    }
                    let p = self.script_parent(&a[0], m)?;
                    let list = self.script_list(p);
                    if m == "children" {
                        list.into_iter()
                            .filter(|c| {
                                matches!(
                                    self.script.nodes.get(c).map(|n| &n.kind),
                                    Some(ScriptKind::Element { .. })
                                )
                            })
                            .collect()
                    } else {
                        list
                    }
                };
                Val::Array(js::array(
                    ids.into_iter()
                        .map(|n| Val::Element(js::Element(n)))
                        .collect(),
                ))
            }
            ("element", m @ ("append" | "prepend")) => {
                let Val::Array(items) = &a[1] else {
                    panic!("validated array")
                };
                let ids: Vec<u64> = items
                    .borrow()
                    .iter()
                    .filter_map(|v| match v {
                        Val::Element(e) => Some(e.0),
                        _ => None,
                    })
                    .collect();
                let p = self.script_parent(&a[0], m)?;
                let before = if m == "prepend" {
                    self.script_list(p).first().copied().map(js::Element)
                } else if p == ScriptParent::Body {
                    return Err(Throw::new(
                        "RunicLayoutError",
                        "append to the body after the container: the interpreter models the body's script content before the container only",
                    ));
                } else {
                    None
                };
                self.script_insert_ids(p, &ids, before, m)?;
                Val::Undefined
            }
            ("element", m @ ("before" | "after" | "replaceWith")) => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let Val::Array(items) = &a[1] else {
                    panic!("validated array")
                };
                let ids: Vec<u64> = items
                    .borrow()
                    .iter()
                    .filter_map(|v| match v {
                        Val::Element(e) => Some(e.0),
                        _ => None,
                    })
                    .collect();
                let Some((p, list)) = self.script_siblings(e.0) else {
                    if self.script.is_script(e.0) {
                        return Ok(Val::Undefined);
                    }
                    return Err(Throw::new(
                        "RunicLayoutError",
                        format!(
                            "{m} of a rendered node needs the native DOM, which the interpreter does not have"
                        ),
                    ));
                };
                let moved = self.script.expand(&ids);
                let mut moved_all = moved.clone();
                moved_all.extend(&ids);
                let at = list.iter().position(|&s| s == e.0).unwrap_or(0);
                let replacing = m == "replaceWith" && !ids.contains(&e.0);
                let before = if replacing {
                    Some(js::Element(e.0))
                } else if m == "before" {
                    match js::script_dom::viable_sibling(&list, at, false, &moved_all) {
                        Some(prev) => {
                            let i = list.iter().position(|&s| s == prev).expect("sibling");
                            list.get(i + 1).copied().map(js::Element)
                        }
                        None => list.first().copied().map(js::Element),
                    }
                } else {
                    js::script_dom::viable_sibling(&list, at, true, &moved_all).map(js::Element)
                };
                if p == ScriptParent::Body && before.is_none() {
                    return Err(Throw::new(
                        "RunicLayoutError",
                        format!(
                            "{m} after the container: the interpreter models the body's script content before the container only"
                        ),
                    ));
                }
                self.script_insert_ids(p, &ids, before, m)?;
                if replacing {
                    self.script.detach(e.0);
                    self.regraft();
                }
                Val::Undefined
            }
            ("element", m @ ("removeChild" | "replaceChild")) => {
                let (Val::Element(p), Val::Element(c)) = (&a[0], a.last().expect("child")) else {
                    panic!("validated elements")
                };
                let parent_ok = match self.script.nodes.get(&c.0).and_then(|n| n.parent) {
                    Some(ScriptParent::Node(q) | ScriptParent::Host(q)) => q == p.0,
                    Some(ScriptParent::Body) => *p == js::Element::BODY,
                    None => false,
                };
                if !parent_ok {
                    if !self.script.is_script(c.0) && !self.script.is_script(p.0) {
                        return Err(Throw::new(
                            "RunicLayoutError",
                            format!(
                                "{m} of a rendered node needs the native DOM, which the interpreter does not have"
                            ),
                        ));
                    }
                    return Err(Throw::new(
                        "NotFoundError",
                        format!(
                            "Failed to execute '{m}' on 'Node': The node to be {} is not a child of this node.",
                            if m == "removeChild" {
                                "removed"
                            } else {
                                "replaced"
                            }
                        ),
                    ));
                }
                if m == "replaceChild" {
                    let Val::Element(n) = &a[1] else {
                        panic!("validated element")
                    };
                    if n != c {
                        let parent = self.script.nodes[&c.0].parent.expect("checked");
                        self.script_insert_ids(parent, &[n.0], Some(*c), m)?;
                        self.script.detach(c.0);
                    }
                } else {
                    self.script.detach(c.0);
                }
                self.regraft();
                Val::Element(*c)
            }
            ("element", "cloneNode") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let deep = matches!(a[1], Val::Bool(true));
                if self.script.is_script(e.0) {
                    Val::Element(js::Element(self.script.clone_node(e.0, deep)))
                } else {
                    let Some(n) = chain_nodes(&self.last_tree, e.0)
                        .and_then(|c| c.last().copied())
                        .cloned()
                    else {
                        return Err(Throw::new(
                            "RunicUnsupportedError",
                            "cloneNode of a node the interpreter does not hold",
                        ));
                    };
                    let mut controls = false;
                    fn walk(n: &VNode, deep: bool, found: &mut bool) {
                        if let VNode::Element { tag, children, .. } = n {
                            if matches!(
                                tag.as_str(),
                                "input" | "textarea" | "select" | "option" | "img"
                            ) {
                                *found = true;
                            }
                            if deep {
                                children.iter().for_each(|c| walk(c, deep, found));
                            }
                        }
                    }
                    walk(&n, deep, &mut controls);
                    if controls {
                        return Err(Throw::new(
                            "RunicUnsupportedError",
                            "cloneNode of a control or image (their cloning steps copy state)",
                        ));
                    }
                    Val::Element(js::Element(self.script.adopt(&n, deep)))
                }
            }
            (
                "element",
                m @ ("class-add" | "class-remove" | "class-toggle" | "class-contains"
                | "class-replace"),
            ) => {
                if let Some(id) = self.rendered_element(&a[0]) {
                    let strings = |v: &Val| -> Vec<String> {
                        match v {
                            Val::Array(xs) => {
                                xs.borrow().iter().map(|x| x.string().to_rust()).collect()
                            }
                            _ => vec![],
                        }
                    };
                    let op = match m {
                        "class-add" => js::script_dom::ClassOp::Add(strings(&a[1])),
                        "class-remove" => js::script_dom::ClassOp::Remove(strings(&a[1])),
                        "class-toggle" => js::script_dom::ClassOp::Toggle(
                            a[1].string().to_rust(),
                            match &a[2] {
                                Val::Bool(b) => Some(*b),
                                _ => None,
                            },
                        ),
                        "class-contains" => {
                            js::script_dom::ClassOp::Contains(a[1].string().to_rust())
                        }
                        _ => js::script_dom::ClassOp::Replace(
                            a[1].string().to_rust(),
                            a[2].string().to_rust(),
                        ),
                    };
                    let current =
                        match chain_nodes(&self.last_tree, id).and_then(|c| c.last().copied()) {
                            Some(VNode::Element { attrs, .. }) => attrs.get("class").cloned(),
                            _ => None,
                        };
                    let (next, result) = js::script_dom::class_list(current.as_deref(), &op)
                        .map_err(|(n, msg)| Throw::new(n, msg))?;
                    if let Some(v) = next {
                        self.script_attr(id, "class", Some(v));
                    }
                    return Ok(match m {
                        "class-add" | "class-remove" => Val::Undefined,
                        _ => Val::Bool(result),
                    });
                }
                let Some(id) = self.script_element(&a[0]) else {
                    if m == "class-contains" {
                        let Val::Element(e) = &a[0] else {
                            panic!("validated element")
                        };
                        let class = match chain_nodes(&self.last_tree, e.0)
                            .and_then(|c| c.last().copied())
                        {
                            Some(VNode::Element { attrs, .. }) => attrs.get("class").cloned(),
                            _ => None,
                        };
                        let op = js::script_dom::ClassOp::Contains(a[1].string().to_rust());
                        let (_, r) = js::script_dom::class_list(class.as_deref(), &op)
                            .map_err(|(n, msg)| Throw::new(n, msg))?;
                        return Ok(Val::Bool(r));
                    }
                    return Err(Throw::new(
                        "RunicLayoutError",
                        format!(
                            "{name} of a rendered element needs the native DOM, which the interpreter does not have"
                        ),
                    ));
                };
                let strings = |v: &Val| -> Vec<String> {
                    match v {
                        Val::Array(xs) => {
                            xs.borrow().iter().map(|x| x.string().to_rust()).collect()
                        }
                        _ => vec![],
                    }
                };
                let op = match m {
                    "class-add" => js::script_dom::ClassOp::Add(strings(&a[1])),
                    "class-remove" => js::script_dom::ClassOp::Remove(strings(&a[1])),
                    "class-toggle" => js::script_dom::ClassOp::Toggle(
                        a[1].string().to_rust(),
                        match &a[2] {
                            Val::Bool(b) => Some(*b),
                            _ => None,
                        },
                    ),
                    "class-contains" => js::script_dom::ClassOp::Contains(a[1].string().to_rust()),
                    _ => js::script_dom::ClassOp::Replace(
                        a[1].string().to_rust(),
                        a[2].string().to_rust(),
                    ),
                };
                let ScriptKind::Element { attrs, .. } =
                    &mut self.script.nodes.get_mut(&id).expect("script").kind
                else {
                    unreachable!("an element")
                };
                let (next, result) =
                    js::script_dom::class_list(attrs.get("class").map(String::as_str), &op)
                        .map_err(|(n, msg)| Throw::new(n, msg))?;
                if let Some(v) = next {
                    attrs.insert("class".into(), v);
                }
                self.regraft();
                match m {
                    "class-add" | "class-remove" => Val::Undefined,
                    _ => Val::Bool(result),
                }
            }
            ("element", "firstChild") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                if *e == js::Element::BODY {
                    return Ok(match self.script.preceding.first() {
                        Some(&c) => Val::Element(js::Element(c)),
                        None => Val::Element(CONTAINER),
                    });
                }
                let parent = self.script_parent(&a[0], "firstChild")?;
                match self.script.list_mut(parent).first().copied() {
                    Some(c) => Val::Element(js::Element(c)),
                    None => Val::Null,
                }
            }
            ("element", "childElementCount") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let count = if self.script.is_script(e.0) {
                    self.script.nodes[&e.0]
                        .children
                        .iter()
                        .filter(|c| matches!(self.script.nodes[c].kind, ScriptKind::Element { .. }))
                        .count()
                } else {
                    match chain_nodes(&self.last_tree, e.0).and_then(|c| c.last().copied()) {
                        Some(VNode::Element { children, .. }) => children
                            .iter()
                            .filter(|c| matches!(c, VNode::Element { .. }))
                            .count(),
                        _ => 0,
                    }
                };
                Val::Num(count as f64)
            }
            // The interpreter renders the templates: script moving their
            // nodes (M6, bits-ui's Command) needs the native DOM.
            ("element", "setAttribute" | "removeAttribute" | "style-set-text")
                if self.rendered_element(&a[0]).is_some() =>
            {
                let id = self.rendered_element(&a[0]).expect("rendered");
                let (attr, value) = match name.split_once('.').map(|x| x.1) {
                    Some("style-set-text") => {
                        let css = a[1].string().to_rust();
                        if let Some(d) = runic_css::dropped_declaration(&css) {
                            let what = format!(
                                "style.cssText with {d}, which the style engine drops (Chromium keeps it)"
                            );
                            self.unsupported.get_or_insert(what.clone());
                            return Err(Throw::new("RunicUnsupportedError", what));
                        }
                        ("style".to_owned(), Some(runic_css::css_text(&css)))
                    }
                    Some("setAttribute") => (
                        a[1].string().to_rust().to_ascii_lowercase(),
                        Some(a[2].string().to_rust()),
                    ),
                    _ => (a[1].string().to_rust().to_ascii_lowercase(), None),
                };
                self.script_attr(id, &attr, value);
                Val::Undefined
            }
            ("element", "setAttribute" | "removeAttribute" | "style-set-text") => {
                return Err(Throw::new(
                    "RunicLayoutError",
                    format!(
                        "{name} of a rendered element needs the native DOM, which the interpreter does not have"
                    ),
                ));
            }
            // The interpreter models no selection (input actions carry
            // whole values): selecting the text changes nothing it observes.
            ("element", "select") => Val::Undefined,
            // A click nested in the script (`detail` 0); nothing inside a
            // disabled control; activation behaviour is not covered.
            ("element", "click") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let tree = self.last_tree.clone();
                if let Some(nodes) = chain_nodes(&tree, e.0) {
                    let disabled = nodes.iter().any(|n| matches!(n, VNode::Element { tag, attrs, .. } if matches!(tag.as_str(), "button" | "input" | "select" | "textarea" | "fieldset") && attrs.contains_key("disabled")));
                    let activates = nodes.iter().any(|n| matches!(n, VNode::Element { tag, attrs, .. } if matches!(tag.as_str(), "input" | "button" | "select" | "textarea" | "option" | "label" | "summary") || (matches!(tag.as_str(), "a" | "area") && attrs.contains_key("href"))));
                    if activates {
                        return Err(Throw::new(
                            "RunicUnsupportedError",
                            "click() of an element with activation behaviour (a control, a label, a link or a summary)",
                        ));
                    }
                    if !disabled {
                        let _ = self.dispatch_nested(
                            e.0,
                            EventKind::Click,
                            js::EventData::default(),
                            true,
                        );
                    }
                }
                Val::Undefined
            }
            ("element", m @ ("focus" | "blur")) => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let tree = self.last_tree.clone();
                let focusable =
                    chain_nodes(&tree, e.0).is_some_and(|n| focus_target(&n) == Some(e.0));
                if m == "focus" && focusable {
                    self.move_focus_nested(Some(e.0));
                } else if m == "blur" && self.focused == Some(e.0) {
                    self.move_focus_nested(None);
                }
                Val::Undefined
            }
            // Libraries compiled from source (M6).
            ("element", "isConnected") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                Val::Bool(match self.script_tree(e.0) {
                    Some(_) => self.script.attachment(e.0) == Some(ScriptParent::Body),
                    None => chain_nodes(&self.last_tree, e.0).is_some(),
                })
            }
            ("element", m @ ("querySelectorAll" | "querySelector")) => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let selector = js::parse_selector(&a[1].string().to_rust()).map_err(|m| {
                    Throw::new("RunicUnsupportedError", format!("querySelector: {m}"))
                })?;
                // (The document as a node value: `document.querySelector`;
                // all matches are not modelled here.)
                if *e == js::Element::DOCUMENT {
                    if m == "querySelectorAll" {
                        return Err(Throw::new(
                            "RunicUnsupportedError",
                            "querySelectorAll of the document, which the interpreter does not model",
                        ));
                    }
                    let preceding: Vec<VNode> = self
                        .script
                        .preceding
                        .iter()
                        .filter_map(|&c| self.script.vnode(c))
                        .collect();
                    return Ok(
                        match document_query(&self.last_tree, self.root_len, &preceding, &selector)?
                        {
                            Some(n) => Val::Element(js::Element(n)),
                            None => Val::Null,
                        },
                    );
                }
                let found = match self.script_tree(e.0) {
                    Some(tree) => {
                        let outer: &[(&'static str, Option<(&'static str, &'static str)>)] =
                            match self.script.attachment(e.0) {
                                Some(ScriptParent::Body) => &[("html", None), ("body", None)],
                                _ => &[],
                            };
                        query_selector_all_in(&tree, e.0, &selector, outer)
                    }
                    None => query_selector_all(&self.last_tree, e.0, &selector),
                };
                if m == "querySelector" {
                    found
                        .first()
                        .map_or(Val::Null, |&n| Val::Element(js::Element(n)))
                } else {
                    Val::Array(js::array(
                        found
                            .into_iter()
                            .map(|n| Val::Element(js::Element(n)))
                            .collect(),
                    ))
                }
            }
            ("element", "focus-visible") => {
                return Err(Throw::new(
                    "RunicUnsupportedError",
                    "the interpreter has no input modality (:focus-visible)",
                ));
            }
            ("element", m @ ("isElement" | "isDocument" | "isNode")) => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                Val::Bool(match m {
                    // (Not a text, comment or fragment node script created.)
                    "isElement" => {
                        e.is_element()
                            && !matches!(
                                self.script.nodes.get(&e.0).map(|n| &n.kind),
                                Some(
                                    ScriptKind::Text(_)
                                        | ScriptKind::Comment(_)
                                        | ScriptKind::Fragment
                                )
                            )
                    }
                    "isNode" => *e != js::Element::WINDOW && *e != js::Element::VISUAL_VIEWPORT,
                    _ => *e == js::Element::DOCUMENT,
                })
            }
            ("element", "isHTML") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                Val::Bool(
                    e.is_element()
                        && !matches!(
                            self.script.nodes.get(&e.0).map(|n| &n.kind),
                            Some(
                                ScriptKind::Text(_) | ScriptKind::Comment(_) | ScriptKind::Fragment
                            )
                        )
                        && chain_nodes(&self.tree_for(e.0), e.0)
                            .and_then(|n| match n.last() {
                                Some(VNode::Element { tag, .. }) => {
                                    Some(!crate::validate::SVG_TAGS.contains(&tag.as_str()))
                                }
                                _ => None,
                            })
                            .unwrap_or(true),
                )
            }
            ("element", "closest") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let selector = js::parse_selector(&a[1].string().to_rust())
                    .map_err(|m| Throw::new("RunicUnsupportedError", format!("closest: {m}")))?;
                if self.script_tree(e.0).is_some() {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        "closest of a script node outside the rendered tree, which the interpreter does not model",
                    ));
                }
                closest(&self.last_tree, self.root_len, e.0, &selector)?
                    .map_or(Val::Null, |n| Val::Element(js::Element(n)))
            }
            ("element", "requestSubmit") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                self.request_submit(e.0)?;
                Val::Undefined
            }
            ("element", "hasAttribute") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let name = a[1].string().to_rust().to_ascii_lowercase();
                Val::Bool(
                    chain_nodes(&self.tree_for(e.0), e.0)
                        .and_then(|n| match n.last() {
                            Some(VNode::Element { attrs, .. }) => Some(attrs.contains_key(&name)),
                            _ => None,
                        })
                        .unwrap_or(false),
                )
            }
            ("element", "getAttribute") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let name = a[1].string().to_rust().to_ascii_lowercase();
                match chain_nodes(&self.tree_for(e.0), e.0).and_then(|n| match n.last() {
                    Some(VNode::Element { attrs, .. }) => attrs.get(&name).cloned(),
                    _ => None,
                }) {
                    Some(v) => Val::Str(JsString::from(v)),
                    None => Val::Null,
                }
            }
            ("element", "localName") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                match chain_nodes(&self.tree_for(e.0), e.0).and_then(|n| n.last().copied()) {
                    Some(VNode::Element { tag, .. }) => Val::Str(JsString::from(tag.as_str())),
                    _ => Val::Str(JsString::new()),
                }
            }
            // The text of its descendant text nodes, in tree order.
            ("element", "textContent") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                fn text(n: &VNode, out: &mut String) {
                    match n {
                        VNode::Text(t) => out.push_str(t),
                        VNode::Element { children, .. } => {
                            children.iter().for_each(|c| text(c, out))
                        }
                    }
                }
                let mut out = String::new();
                if self.script.is_script(e.0) {
                    out = self.script.text(e.0);
                } else if let Some(n) =
                    chain_nodes(&self.last_tree, e.0).and_then(|n| n.last().copied())
                {
                    text(n, &mut out);
                }
                Val::Str(JsString::from(out.as_str()))
            }
            // The parent inside the program's DOM: none at its top level.
            ("element", "contains") => {
                let (Val::Element(a0), Val::Element(b0)) = (&a[0], &a[1]) else {
                    panic!("validated elements")
                };
                if self.script_tree(b0.0).is_some() || self.script_tree(a0.0).is_some() {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        "contains of a script node outside the rendered tree, which the interpreter does not model",
                    ));
                }
                let chain = chain_nodes(&self.last_tree, b0.0);
                Val::Bool(
                    a0 == b0
                        || (*a0 == js::Element::BODY && chain.is_some())
                        || chain.is_some_and(|c| c.iter().any(|n| element_id(n) == Some(a0.0))),
                )
            }
            ("element", "parent") => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                if let Some(n) = self.script.nodes.get(&e.0) {
                    return Ok(match n.parent {
                        // (A fragment is no element.)
                        Some(ScriptParent::Node(p))
                            if matches!(self.script.nodes[&p].kind, ScriptKind::Fragment) =>
                        {
                            Val::Null
                        }
                        Some(ScriptParent::Node(p) | ScriptParent::Host(p)) => {
                            Val::Element(js::Element(p))
                        }
                        Some(ScriptParent::Body) => Val::Element(js::Element::BODY),
                        None => Val::Null,
                    });
                }
                let chain = chain_nodes(&self.last_tree, e.0).unwrap_or_default();
                match chain
                    .len()
                    .checked_sub(2)
                    .and_then(|i| element_id(chain[i]))
                {
                    Some(p) => Val::Element(js::Element(p)),
                    // Content mounted in the body (M6) has the body as its parent.
                    None if chain.len() == 1
                        && self.last_tree[self.root_len.min(self.last_tree.len())..]
                            .iter()
                            .any(|n| element_id(n) == Some(e.0)) =>
                    {
                        Val::Element(js::Element::BODY)
                    }
                    None => Val::Null,
                }
            }
            // `beforematch` listeners: the runtime never fires the event.
            ("element", "listen" | "unlisten") if a[1].string().to_rust() == "beforematch" => {
                Val::Undefined
            }
            // Other element listeners added by script (the interpreter
            // scrolls no element: its `scroll` listeners are never called).
            ("element", m @ ("listen" | "unlisten")) => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let kind = EventKind::parse(&a[1].string().to_rust()).expect("validated kind");
                let f = a[2].clone();
                let at = self
                    .element_listeners
                    .iter()
                    .position(|g| g.0 == e.0 && g.1 == kind && g.2.same(&f));
                match (m, at) {
                    ("listen", None) => {
                        let registration = self.next_listener_registration();
                        self.element_listeners.push((e.0, kind, f, registration));
                    }
                    ("unlisten", Some(i)) => {
                        self.element_listeners.remove(i);
                    }
                    _ => {}
                }
                Val::Undefined
            }
            // An observer that never observed has nothing to disconnect.
            ("mutation", "disconnect") => Val::Undefined,
            ("mutation", "new") => {
                let Type::Record(r) = ty else {
                    panic!("validated MutationObserver record")
                };
                Val::Record(JsRef::new(RecordData::new(*r, vec![a[0].clone()], true)))
            }
            // ResizeObservers (M6): created as records holding their
            // callback; observing needs layout (above), so an observer that
            // never observed has nothing to stop.
            ("resize", "new") => {
                let Type::Record(r) = ty else {
                    panic!("validated ResizeObserver record")
                };
                Val::Record(JsRef::new(RecordData::new(*r, vec![a[0].clone()], true)))
            }
            ("resize", "unobserve" | "disconnect") => Val::Undefined,
            // IntersectionObservers (M6 overlays): the options are checked as
            // the constructor checks them; observing needs layout (above).
            ("intersection", "new") => {
                let Type::Record(r) = ty else {
                    panic!("validated IntersectionObserver record")
                };
                js::intersection::parse_root_margin(&a[1].string().to_rust())
                    .map_err(|m| Throw::new("SyntaxError", m))?;
                let values: Vec<f64> = a[2].array().borrow().iter().map(|v| v.num()).collect();
                js::intersection::thresholds(&values).map_err(|m| Throw::new("RangeError", m))?;
                Val::Record(JsRef::new(RecordData::new(*r, vec![a[0].clone()], true)))
            }
            ("intersection", "unobserve" | "disconnect") => Val::Undefined,
            ("effect", phase @ ("pre" | "post")) => {
                let phase = if phase == "pre" {
                    EffectPhase::Pre
                } else {
                    EffectPhase::Post
                };
                self.create_effect(phase, a[0].clone())?;
                Val::Undefined
            }
            ("effect", "root") => Val::Num(self.create_root(&a[0])? as f64),
            ("reactive", "keyed-read") => {
                if self.tracking.is_some() && self.in_effect {
                    self.unsupported.get_or_insert(KEYED_READ.to_string());
                }
                Val::Undefined
            }
            ("effect", "destroy-root") => {
                self.destroy_root(a[0].num() as usize);
                Val::Undefined
            }
            ("reactive", "untrack-call") => {
                let outer = self.tracking.take();
                let heap_outer = js::begin_heap_reads(None);
                let r = self.call_value(&a[0], a[1..].to_vec());
                js::end_heap_reads(heap_outer);
                self.tracking = outer;
                r?
            }
            ("context", "set") => {
                let Some(i) = self.creating else {
                    return Err(Throw::new(
                        "RunicContextError",
                        "contexts are set while a component instance is created",
                    ));
                };
                self.instances[i]
                    .contexts
                    .insert(a[0].string().to_rust(), a[1].clone());
                a[1].clone()
            }
            ("context", "get") => {
                let key = a[0].string().to_rust();
                let mut at = self.creating;
                if at.is_none() {
                    return Err(Throw::new(
                        "RunicContextError",
                        "contexts are read while a component instance is created",
                    ));
                }
                let mut found = Val::Undefined;
                while let Some(i) = at {
                    if let Some(v) = self.instances[i].contexts.get(&key) {
                        found = v.clone();
                        break;
                    }
                    at = self.instances[i].context_parent;
                }
                found
            }
            // The contexts the instance being created sees (Svelte's
            // getAllContexts(): its own and its ancestors').
            ("context", "all") => match self.creating {
                Some(i) => Val::Contexts(i),
                None => {
                    return Err(Throw::new(
                        "RunicContextError",
                        "contexts are read while a component instance is created",
                    ));
                }
            },
            // Image objects (M6 images): their state; no image loads.
            ("image", "new") => Val::Image(Rc::new(RefCell::new(ImageObject::default()))),
            ("image", m) => {
                let Val::Image(i) = &a[0] else {
                    panic!("validated image")
                };
                let mut i = i.borrow_mut();
                let error = || matches!(&a[1], Val::Str(k) if k.to_rust() == "error");
                match m {
                    "set-src" => {
                        let Val::Str(s) = &a[1] else {
                            panic!("validated string")
                        };
                        i.src = Some(s.clone());
                        Val::Undefined
                    }
                    "src" => {
                        return Err(Throw::new(
                            "RunicUnsupportedError",
                            "the interpreter does not resolve image URLs (image.src)",
                        ));
                    }
                    "cross-origin" => i
                        .cross_origin
                        .map_or(Val::Null, |v| Val::Str(JsString::from(v))),
                    "set-cross-origin" => {
                        i.cross_origin = match &a[1] {
                            Val::Null => js::image::cross_origin(None),
                            Val::Str(s) => js::image::cross_origin(Some(&s.to_rust())),
                            _ => js::image::cross_origin(Some("undefined")),
                        };
                        Val::Undefined
                    }
                    "referrer-policy" => Val::Str(JsString::from(i.referrer_policy)),
                    "set-referrer-policy" => {
                        let Val::Str(s) = &a[1] else {
                            panic!("validated string")
                        };
                        i.referrer_policy = js::image::referrer_policy(&s.to_rust());
                        Val::Undefined
                    }
                    "handler" => {
                        let e = error();
                        i.listeners
                            .iter()
                            .find(|l| l.0 == e && l.1)
                            .map_or(Val::Null, |l| l.2.clone())
                    }
                    "set-handler" => {
                        let e = error();
                        let at = i.listeners.iter().position(|l| l.0 == e && l.1);
                        match (&a[2], at) {
                            (Val::Null | Val::Undefined, Some(at)) => {
                                i.listeners.remove(at);
                            }
                            (Val::Null | Val::Undefined, None) => {}
                            (f, Some(at)) => i.listeners[at].2 = f.clone(),
                            (f, None) => i.listeners.push((e, true, f.clone())),
                        }
                        Val::Undefined
                    }
                    "listen" => {
                        let e = error();
                        if !i
                            .listeners
                            .iter()
                            .any(|l| l.0 == e && !l.1 && strict_equal(&l.2, &a[2]))
                        {
                            i.listeners.push((e, false, a[2].clone()));
                        }
                        Val::Undefined
                    }
                    "unlisten" => {
                        let e = error();
                        i.listeners
                            .retain(|l| !(l.0 == e && !l.1 && strict_equal(&l.2, &a[2])));
                        Val::Undefined
                    }
                    _ => panic!("validated image built-in {m}"),
                }
            }
            ("mounted", "unmount") => {
                let Val::Mounted(h) = &a[0] else {
                    panic!("validated mounted instance")
                };
                if let Some(id) = h.take() {
                    self.unmount(id);
                }
                Val::Promise(Promise::fulfilled(Val::Undefined))
            }
            ("document", "body") => Val::Element(js::Element::BODY),
            ("document", "element") => Val::Element(js::Element::HTML),
            ("navigator", "user-agent") => Val::Str(JsString::from(js::user_agent())),
            ("uid", "next") => {
                self.uids += 1;
                Val::Str(JsString::from(format!(
                    "{}{}",
                    a[0].string().to_rust(),
                    self.uids
                )))
            }
            ("attrs", m) => self.attrs_builtin(m, &a, ty)?,
            (family @ ("root" | "body"), m) => {
                let arg = |i: usize| a[i].string().to_rust();
                let el = if family == "root" {
                    &mut self.root
                } else {
                    &mut self.body
                };
                let dom_error =
                    |(name, message): runic_css::root::TokenError| Throw::new(name, message);
                match m {
                    "get-attr" => match el.get(&arg(0)) {
                        Some(v) => Val::Str(JsString::from(v)),
                        None => Val::Null,
                    },
                    "set-attr" => {
                        el.set(&arg(0), &arg(1));
                        Val::Undefined
                    }
                    "remove-attr" => {
                        el.remove(&arg(0));
                        Val::Undefined
                    }
                    "class-contains" => Val::Bool(el.class_contains(&arg(0))),
                    "class-toggle" => {
                        let force = a.get(1).map(Val::boolean);
                        Val::Bool(el.class_toggle(&arg(0), force).map_err(dom_error)?)
                    }
                    "class-add" | "class-remove" => {
                        self.root
                            .class_set(&arg(0), m == "class-add")
                            .map_err(dom_error)?;
                        Val::Undefined
                    }
                    "style-set" => {
                        el.style_set(&arg(0), &arg(1));
                        Val::Undefined
                    }
                    "style-remove" => Val::Str(JsString::from(el.style_remove(&arg(0)))),
                    "style-get" => Val::Str(JsString::from(el.style_get(&arg(0)))),
                    other => panic!("validated document element operation {other}"),
                }
            }
            ("media", "matches") => Val::Bool(
                runic_css::media_matches(&a[0].string().to_rust(), &self.media).unwrap_or(false),
            ),
            ("media", "query") => {
                let q = a[0].string().to_rust();
                let matches = runic_css::media_matches(&q, &self.media).unwrap_or(false);
                Val::MediaQuery(js::MediaQueryList::new(&q, matches))
            }
            ("media-query", m) => {
                let Val::MediaQuery(list) = &a[0] else {
                    panic!("validated media query list")
                };
                match m {
                    "matches" => Val::Bool(
                        runic_css::media_matches(list.query(), &self.media).unwrap_or(false),
                    ),
                    "listen" | "unlisten" => {
                        let f = a[1].clone();
                        let at = self.media_lists.iter().position(|(l, _)| l == list);
                        match (m, at) {
                            ("listen", None) => {
                                // Lists notify oldest first.
                                let i = self
                                    .media_lists
                                    .iter()
                                    .position(|(l, _)| l.order() > list.order())
                                    .unwrap_or(self.media_lists.len());
                                self.media_lists.insert(i, (list.clone(), vec![f]));
                            }
                            ("listen", Some(i)) => {
                                if !self.media_lists[i].1.iter().any(|g| g.same(&f)) {
                                    self.media_lists[i].1.push(f);
                                }
                            }
                            ("unlisten", Some(i)) => self.media_lists[i].1.retain(|g| !g.same(&f)),
                            _ => {}
                        }
                        Val::Undefined
                    }
                    other => panic!("validated media query list member {other}"),
                }
            }
            ("visual-viewport", m @ ("listen" | "unlisten")) => {
                let kind = EventKind::parse(&a[0].string().to_rust()).expect("validated kind");
                let f = a[1].clone();
                let at = self
                    .viewport_listeners
                    .iter()
                    .position(|g| g.0 == kind && g.1.same(&f));
                match (m, at) {
                    ("listen", None) => self.viewport_listeners.push((kind, f)),
                    ("unlisten", Some(i)) => {
                        self.viewport_listeners.remove(i);
                    }
                    _ => {}
                }
                Val::Undefined
            }
            (target @ ("window" | "document"), m @ ("listen-capture" | "unlisten-capture")) => {
                let window = target == "window";
                let kind = EventKind::parse(&a[0].string().to_rust()).expect("validated kind");
                let f = a[1].clone();
                let at = self
                    .capture_listeners
                    .iter()
                    .position(|g| g.0 == window && g.1 == kind && g.2.same(&f));
                match (m, at) {
                    ("listen-capture", None) => {
                        let registration = self.next_listener_registration();
                        self.capture_listeners.push((window, kind, f, registration));
                    }
                    ("unlisten-capture", Some(i)) => {
                        self.capture_listeners.remove(i);
                    }
                    _ => {}
                }
                Val::Undefined
            }
            (target @ ("window" | "document"), m @ ("listen" | "unlisten")) => {
                let window = target == "window";
                let kind = EventKind::parse(&a[0].string().to_rust()).expect("validated kind");
                let f = a[1].clone();
                let at = self
                    .host_listeners
                    .iter()
                    .position(|g| g.0 == window && g.1 == kind && g.2.same(&f));
                match (m, at) {
                    // Adding a registered listener again does nothing.
                    ("listen", None) => {
                        let registration = self.next_listener_registration();
                        self.host_listeners.push((window, kind, f, registration));
                    }
                    ("unlisten", Some(i)) => {
                        self.host_listeners.remove(i);
                    }
                    _ => {}
                }
                Val::Undefined
            }
            ("event", "new") => Val::Event(js::Event::new(js::EventData {
                kind: a[0].string(),
                cancelable: matches!(a[1], Val::Bool(true)),
                bubbles: matches!(a.get(2), Some(Val::Bool(true))),
                synthetic: true,
                ..Default::default()
            })),
            ("custom", m @ ("listen" | "unlisten")) => {
                let Val::Element(e) = &a[0] else {
                    panic!("validated element")
                };
                let name = a[1].string();
                if EventKind::parse(&name.to_rust()).is_some() {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        format!(
                            "a listener of native {} events added with a type known at run time",
                            name.to_rust()
                        ),
                    ));
                }
                let f = a[2].clone();
                let at = self
                    .custom_listeners
                    .iter()
                    .position(|g| g.0 == e.0 && g.1 == name && g.2.same(&f));
                match (m, at) {
                    ("listen", None) => self.custom_listeners.push((e.0, name, f)),
                    ("unlisten", Some(i)) => {
                        self.custom_listeners.remove(i);
                    }
                    _ => {}
                }
                Val::Undefined
            }
            // An event created by script dispatched at an element: its
            // listeners run at once (the target's, then its ancestors' where
            // it bubbles); a throwing listener is reported, the others run.
            ("element", "dispatchEvent") => {
                let (Val::Element(e), Val::Event(ev)) = (&a[0], &a[1]) else {
                    panic!("validated element and event")
                };
                let name = ev.data().kind.clone();
                if !ev.data().synthetic || EventKind::parse(&name.to_rust()).is_some() {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        format!("dispatchEvent of a {} event", name.to_rust()),
                    ));
                }
                let mut path: Vec<u64> = match chain_nodes(&self.last_tree, e.0) {
                    Some(nodes) => nodes
                        .iter()
                        .filter_map(|n| match n {
                            VNode::Element { id, .. } => Some(*id),
                            VNode::Text(_) => None,
                        })
                        .collect(),
                    None => vec![e.0],
                };
                path.reverse();
                if !ev.data().bubbles {
                    path.truncate(1);
                }
                for node in path {
                    let fs: Vec<Val> = self
                        .custom_listeners
                        .iter()
                        .filter(|g| g.0 == node && g.1 == name)
                        .map(|g| g.2.clone())
                        .collect();
                    for f in fs {
                        if !ev.enter(js::Element(node)) {
                            break;
                        }
                        if let Err(t) = self.call_value(&f, vec![Val::Event(ev.clone())]) {
                            self.uncaught.push(t);
                        }
                    }
                    if ev.propagation_stopped() {
                        break;
                    }
                }
                ev.finish();
                Val::Bool(!ev.default_prevented())
            }
            ("event", "instance-of") => {
                let Val::Event(e) = &a[0] else {
                    panic!("validated event")
                };
                let class = a[1].string().to_rust();
                match e.data().instance_of(&class) {
                    Some(v) => Val::Bool(v),
                    None => {
                        return Err(Throw::new(
                            "RunicUnsupportedError",
                            format!("instanceof {class} of a {} event", e.data().kind.to_rust()),
                        ));
                    }
                }
            }
            ("event", "keyboard") => {
                let Val::Event(src) = &a[1] else {
                    panic!("validated event")
                };
                let d = src.data();
                Val::Event(js::Event::new(js::EventData {
                    kind: a[0].string(),
                    key: d.key.clone(),
                    code: d.code.clone(),
                    ctrl: d.ctrl,
                    shift: d.shift,
                    alt: d.alt,
                    meta: d.meta,
                    repeat: d.repeat,
                    composing: d.composing,
                    cancelable: d.cancelable,
                    synthetic: true,
                    keyboard: true,
                    ..Default::default()
                }))
            }
            ("event", m) => {
                let Val::Event(e) = &a[0] else {
                    panic!("validated event")
                };
                let d = e.data();
                if d.synthetic
                    && !(d.keyboard
                        && matches!(
                            m,
                            "key"
                                | "code"
                                | "ctrlKey"
                                | "shiftKey"
                                | "altKey"
                                | "metaKey"
                                | "repeat"
                                | "isComposing"
                        ))
                    && !matches!(
                        m,
                        "type"
                            | "defaultPrevented"
                            | "preventDefault"
                            | "stopPropagation"
                            | "stopImmediatePropagation"
                    )
                {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        format!("{m} of an event created by script"),
                    ));
                }
                match m {
                    "type" => Val::Str(d.kind.clone()),
                    "key" => Val::Str(d.key.clone()),
                    "code" => Val::Str(d.code.clone()),
                    "value" => Val::Str(d.value.clone()),
                    "ctrlKey" => Val::Bool(d.ctrl),
                    "shiftKey" => Val::Bool(d.shift),
                    "altKey" => Val::Bool(d.alt),
                    "metaKey" => Val::Bool(d.meta),
                    "repeat" => Val::Bool(d.repeat),
                    "isComposing" => Val::Bool(d.composing),
                    "checked" => Val::Bool(d.checked),
                    "matches" => Val::Bool(d.matches),
                    "defaultPrevented" => Val::Bool(e.default_prevented()),
                    "clientX" => Val::Num(d.client_x),
                    "clientY" => Val::Num(d.client_y),
                    "button" => Val::Num(d.button),
                    "buttons" => Val::Num(d.buttons),
                    "detail" => Val::Num(d.detail),
                    "pointerId" => match d.pointer_id() {
                        Some(id) => Val::Num(id),
                        None => {
                            return Err(Throw::new(
                                "RunicUnsupportedError",
                                "pointerId of an event that is not a pointer event",
                            ));
                        }
                    },
                    "pointerType" => match d.pointer_type() {
                        Some(t) => Val::Str(JsString::from(t)),
                        None => {
                            return Err(Throw::new(
                                "RunicUnsupportedError",
                                "pointerType of an event that is not a pointer event",
                            ));
                        }
                    },
                    "deltaX" => Val::Num(d.delta_x),
                    "deltaY" => Val::Num(d.delta_y),
                    "target" => Val::Element(d.target),
                    "relatedTarget" => d.related.map_or(Val::Null, Val::Element),
                    "currentTarget" => e.current_target().map_or(Val::Null, Val::Element),
                    "path-target" => {
                        if d.media {
                            return Err(Throw::new(
                                "RunicUnsupportedError",
                                "composedPath() of a MediaQueryList change event",
                            ));
                        }
                        e.path_target().map_or(Val::Undefined, Val::Element)
                    }
                    "preventDefault" => {
                        e.prevent_default();
                        Val::Undefined
                    }
                    "stopPropagation" => {
                        e.stop_propagation();
                        Val::Undefined
                    }
                    "stopImmediatePropagation" => {
                        e.stop_immediate_propagation();
                        Val::Undefined
                    }
                    other => panic!("validated event member {other}"),
                }
            }
            ("maybe", "is-null") => Val::Bool(matches!(a[0], Val::Null)),
            ("maybe", "is-undefined") => Val::Bool(matches!(a[0], Val::Undefined)),
            ("maybe", "is-nullish") => Val::Bool(matches!(a[0], Val::Undefined | Val::Null)),
            ("JSON", "stringify") => {
                let indent = match a.get(2) {
                    Some(Val::Num(x)) => js::json::Indent::Spaces(*x),
                    Some(Val::Str(t)) => js::json::Indent::Text(t.clone()),
                    _ => js::json::Indent::None,
                };
                match self.to_json(&a[0]) {
                    Some(j) => Val::Str(js::json::stringify(&j, &indent)),
                    None => Val::Undefined,
                }
            }
            ("JSON", "parse") => {
                let j = js::json::parse(&s(0))?;
                self.from_json(&j, ty)?
            }
            ("Object", "keys") => {
                let Val::Record(r) = &a[0] else {
                    panic!("validated record")
                };
                let rec = &self.program.records[r.borrow().record];
                Val::Array(js::array(
                    rec.fields
                        .iter()
                        .map(|f| Val::Str(JsString::from(f.name.as_str())))
                        .collect(),
                ))
            }
            ("Object", "values") => {
                let Val::Record(r) = &a[0] else {
                    panic!("validated record")
                };
                Val::Array(js::array(r.borrow().fields.clone()))
            }
            _ => unreachable!("validated builtin {name}"),
        };
        Ok(v)
    }

    /// Attribute bag built-ins (M6, docs/IR.md "Attribute bags").
    fn attrs_builtin(&self, m: &str, a: &[Val], ty: &Type) -> Res<Val> {
        let bag = |v: &Val| -> Rc<Vec<(String, Val)>> {
            match v {
                Val::Attrs(b) => b.clone(),
                other => panic!("validated bag, found {other:?}"),
            }
        };
        if m == "style-map" {
            let b = bag(&a[0]);
            let mut entries = vec![];
            for (n, v) in resolve_attrs(&b) {
                let value = match v {
                    Val::Str(s) => Val::Str(s.clone()),
                    Val::Num(x) => Val::Str(JsString::from(js::number_to_string(*x))),
                    Val::Undefined | Val::Null => Val::Undefined,
                    _ => {
                        return Err(Throw::new(
                            "RunicUnsupportedError",
                            format!("a style property {n} that is not text or a number"),
                        ));
                    }
                };
                entries.push((Val::Str(JsString::from(n)), value));
            }
            return Ok(Val::Map(js::array_ops::map_new(entries)));
        }
        if m == "style-text" {
            let ops = MergeVals {
                program: self.program,
            };
            let js::MergeKind::Style(entries) = js::MergeOps::kind(&ops, &a[0]) else {
                panic!("validated style object")
            };
            return Ok(Val::Str(js::style_to_string(&entries)));
        }
        Ok(match m {
            "has" => {
                let name = a[1].string().to_rust();
                Val::Bool(bag(&a[0]).iter().any(|(n, _)| *n == name))
            }
            "get" => {
                let name = a[1].string().to_rust();
                let b = bag(&a[0]);
                let v = resolve_attrs(&b)
                    .into_iter()
                    .find(|(n, _)| *n == name)
                    .map_or(Val::Undefined, |(_, v)| v.clone());
                let Type::Maybe(inner) = ty else {
                    panic!("validated attrs.get type")
                };
                // A style object entry read as a dictionary (M6 overlays:
                // bits-ui forwards \`style\`): a new dictionary of its
                // properties in order, as the native runtime builds one.
                let v = match (&v, &**inner) {
                    (Val::Record(r), Type::Map(k, _))
                        if **k == Type::String && !r.borrow().class =>
                    {
                        let data = r.borrow();
                        let rec = &self.program.records[data.record];
                        Val::Map(js::array_ops::map_new(
                            rec.fields
                                .iter()
                                .zip(&data.fields)
                                .map(|(f, x)| {
                                    (Val::Str(JsString::from(f.name.as_str())), x.clone())
                                })
                                .collect(),
                        ))
                    }
                    _ => v,
                };
                let fits = match (&v, &**inner) {
                    (Val::Undefined | Val::Null, _) => true,
                    (Val::Str(_), Type::String) | (Val::Bool(_), Type::Boolean) => true,
                    (Val::Closure(_) | Val::Listeners(_), Type::Fn(_)) => true,
                    // A value of another type (M6 overlays), by its kind.
                    (v, t) if crate::builtins::bag_value_type(t) => match (v, t) {
                        (Val::Num(_), Type::Number)
                        | (Val::Array(_), Type::Array(_))
                        | (Val::Map(_), Type::Map(..))
                        | (Val::Set(_), Type::Set(_))
                        | (Val::Element(_), Type::Element)
                        | (Val::Promise(_), Type::Promise(_))
                        | (Val::RegExp(_), Type::Regexp)
                        | (Val::MediaQuery(_), Type::MediaQuery)
                        | (Val::Date(_), Type::Date) => true,
                        (Val::Record(r), t) => {
                            let record = r.borrow().record;
                            match t {
                                Type::Record(x) => *x == record,
                                _ => self
                                    .program
                                    .class_members(t)
                                    .is_some_and(|m| m.contains(&record)),
                            }
                        }
                        _ => false,
                    },
                    _ => false,
                };
                if !fits {
                    return Err(Throw::type_error(format!(
                        "RunicAttrsError: the spread passes {name} a value of another type than the prop's"
                    )));
                }
                v
            }
            "without" => {
                let names: Vec<String> = a[1..].iter().map(|n| n.string().to_rust()).collect();
                let b = bag(&a[0]);
                Val::Attrs(Rc::new(
                    b.iter()
                        .filter(|(n, _)| !names.contains(n))
                        .cloned()
                        .collect(),
                ))
            }
            "merge-props" => {
                let bags: Vec<Vec<(String, Val)>> = a.iter().map(|v| (*bag(v)).clone()).collect();
                let merged = js::merge_props(
                    &bags,
                    &MergeVals {
                        program: self.program,
                    },
                )
                .map_err(|m| Throw::new("RunicUnsupportedError", m))?;
                Val::Attrs(Rc::new(merged))
            }
            other => panic!("validated attrs built-in {other}"),
        })
    }

    fn to_json(&self, v: &Val) -> Option<js::json::Json> {
        use js::json::Json as J;
        Some(match v {
            Val::Undefined
            | Val::Closure(_)
            | Val::Resolver(_)
            | Val::Listeners(_)
            | Val::Element(_)
            | Val::Event(_)
            | Val::RegExp(_)
            | Val::MediaQuery(_)
            | Val::Date(_)
            | Val::Mounted(_)
            | Val::Contexts(_)
            | Val::Image(_)
            | Val::DynObject(_)
            | Val::Boxed(_)
            | Val::DynFn(_)
            | Val::Attrs(_) => return None,
            // A promise has no own enumerable properties.
            Val::Promise(_) => J::Object(Default::default()),
            Val::Null => J::Null,
            Val::Bool(b) => J::Bool(*b),
            Val::Num(n) => {
                if n.is_finite() {
                    J::Num(*n)
                } else {
                    J::Null
                }
            }
            Val::Str(s) => J::Str(s.clone()),
            Val::Array(a) => J::Array(
                a.borrow()
                    .iter()
                    .map(|x| self.to_json(x).unwrap_or(J::Null))
                    .collect(),
            ),
            Val::Record(r) => {
                let r = r.borrow();
                let rec = &self.program.records[r.record];
                J::Object(
                    rec.fields
                        .iter()
                        .zip(&r.fields)
                        .filter_map(|(f, x)| {
                            self.to_json(x)
                                .map(|j| (JsString::from(f.name.as_str()), j))
                        })
                        .collect(),
                )
            }
            Val::Map(_) | Val::Set(_) => J::Object(vec![]),
        })
    }

    fn from_json(&self, j: &js::json::Json, ty: &Type) -> Res<Val> {
        use js::json::Json as J;
        let bad = |want: &str| {
            Err(Throw::syntax_error(format!(
                "JSON value does not match the expected type: expected {want}"
            )))
        };
        Ok(match (ty, j) {
            (Type::Maybe(_), J::Null) => Val::Null,
            (Type::Maybe(inner), other) => self.from_json(other, inner)?,
            (Type::Number, J::Num(n)) => Val::Num(*n),
            (Type::String, J::Str(s)) => Val::Str(s.clone()),
            (Type::Boolean, J::Bool(b)) => Val::Bool(*b),
            (Type::Array(e), J::Array(items)) => Val::Array(js::array(
                items
                    .iter()
                    .map(|x| self.from_json(x, e))
                    .collect::<Res<Vec<_>>>()?,
            )),
            (Type::Record(r), J::Object(members)) => {
                let rec = &self.program.records[*r];
                let mut fields = vec![];
                for f in &rec.fields {
                    match members.iter().find(|(k, _)| k.to_rust() == f.name) {
                        Some((_, v)) => fields.push(self.from_json(v, &f.ty)?),
                        None if matches!(f.ty, Type::Maybe(_)) => fields.push(Val::Undefined),
                        None => return bad(&format!("field {}", f.name)),
                    }
                }
                Val::Record(JsRef::new(RecordData::new(
                    *r,
                    fields,
                    self.program.records[*r].class,
                )))
            }
            (t, _) => return bad(&t.name()),
        })
    }

    fn clone_deep(&self, v: &Val) -> Val {
        match v {
            Val::Array(a) => Val::Array(js::array(
                a.borrow().iter().map(|x| self.clone_deep(x)).collect(),
            )),
            Val::Record(r) => {
                let r = r.borrow();
                Val::Record(JsRef::new(RecordData::new(
                    r.record,
                    r.fields.iter().map(|x| self.clone_deep(x)).collect(),
                    r.class,
                )))
            }
            Val::Map(m) => {
                let entries = m
                    .borrow()
                    .entries
                    .values()
                    .map(|(k, x)| (self.clone_deep(k), self.clone_deep(x)))
                    .collect();
                Val::Map(js::array_ops::map_new(entries))
            }
            Val::Set(s) => Val::Set(js::array_ops::set_new(
                s.borrow()
                    .entries
                    .values()
                    .map(|x| self.clone_deep(x))
                    .collect(),
            )),
            other => other.clone(),
        }
    }

    // Rendering -------------------------------------------------------------------

    /// Render the program. Rendering also reconciles instances: children are
    /// created on first render, receive changed props, and are destroyed when
    /// no longer rendered.
    pub fn render(&mut self) -> Result<Vec<VNode>> {
        // The listeners of the tree before this update (a focused element
        // that the update removes gets its blur events on that tree).
        let previous_listeners = std::mem::take(&mut self.listeners);
        let previous_capture = std::mem::take(&mut self.capture_elements);
        self.moved.clear();
        self.order.clear();
        let mut visited = HashSet::new();
        let mut out = vec![];
        let previous = std::mem::take(&mut self.refs);
        self.rendered_elements.clear();
        self.rendered_ids.clear();
        self.script_hosts.clear();
        let mut result = self.render_instance(0, &mut out, &mut visited);
        // Mounted instances (M6), each the body's last children at its mount.
        let mut portals: Vec<Vec<VNode>> = vec![];
        for (_, id) in self.mounted.clone() {
            if result.is_err() {
                break;
            }
            visited.insert(id);
            self.order.push(id);
            let mut content = vec![];
            result = self.render_instance(id, &mut content, &mut visited);
            portals.push(content);
        }
        self.restore_due = false;
        let rendered = std::mem::take(&mut self.rendered_elements);
        self.element_ids.retain(|k, _| rendered.contains(k));
        // Attachments of elements no longer rendered are cleaned up.
        let gone: Vec<u64> = self
            .attached
            .keys()
            .copied()
            .filter(|e| !self.rendered_ids.contains(e))
            .collect();
        for e in gone {
            for a in self.attached.remove(&e).unwrap_or_default() {
                if let Some(Some(c)) = a.cleanup {
                    self.detached.push(c);
                }
            }
        }
        // Refs of elements that are no longer rendered become null.
        for ((inst, cell), id) in previous {
            if !self.refs.contains_key(&(inst, cell))
                && matches!(self.instances[inst].cells[cell], Val::Element(e) if e.0 == id)
            {
                self.instances[inst].cells[cell] = Val::Null;
                self.ref_changed(inst, cell);
                self.forward_ref(inst, cell, Val::Null)
                    .map_err(throw_diag)?;
            }
        }
        // Destroy instances that were not rendered.
        let instances = &mut self.instances;
        self.children.retain(|_, id| {
            let keep = visited.contains(id);
            if !keep {
                instances[*id].alive = false;
            }
            keep
        });
        result.map_err(throw_diag)?;
        let mut tree = normalize(out);
        self.root_len = tree.len();
        for p in portals {
            tree.extend(normalize(p));
        }
        for n in form_tree_elements(&self.last_tree) {
            if let VNode::Element {
                id, tag, children, ..
            } = n
            {
                if tag == "form"
                    && !is_form(&tree, *id)
                    && form_subtree_shadows_request_submit(children)
                {
                    self.detached_shadowed_forms.insert(*id);
                }
            }
        }
        for n in form_tree_elements(&tree) {
            if let VNode::Element { id, tag, .. } = n {
                if tag == "form" {
                    self.known_forms.insert(*id);
                }
            }
        }
        // A radio button checked by this render unchecks the others of its
        // group, in render order (the later one wins, as in Chromium).
        for radio in std::mem::take(&mut self.checked_radios) {
            self.live_checked.insert(radio, true);
            set_tree_checked(&mut tree, radio, true);
            for (other, _) in radio_group(&tree, radio) {
                if other != radio {
                    self.live_checked.insert(other, false);
                    set_tree_checked(&mut tree, other, false);
                }
            }
        }
        // Focus is lost with its element: Chromium dispatches `blur` and
        // `focusout` at once when the element (or an ancestor) is removed,
        // while it is still in the document, so on the previous tree with
        // its listeners; they run nested in the update.
        // A keyed move detaches the moved block first: the same events, and
        // frameworks that restore focus around their DOM updates (React DOM)
        // focus it again afterwards.
        let moved = self.focused.filter(|f| self.moved.contains(f));
        if let Some(f) = self
            .focused
            .filter(|&f| chain_nodes(&tree, f).is_none() || moved == Some(f))
        {
            self.focused = None;
            let current = std::mem::replace(&mut self.listeners, previous_listeners);
            let current_capture = std::mem::replace(&mut self.capture_elements, previous_capture);
            let value = chain_nodes(&self.last_tree, f).and_then(|n| match n.last() {
                Some(VNode::Element { value, .. }) => value.clone(),
                _ => None,
            });
            for kind in [EventKind::Blur, EventKind::Focusout] {
                let data = js::EventData {
                    value: value.as_deref().unwrap_or_default().into(),
                    ..Default::default()
                };
                let elements = !self.program.schedule.commit_events_ignored;
                let _ = self.dispatch_nested(f, kind, data, elements);
            }
            self.listeners = current;
            self.capture_elements = current_capture;
            if moved.is_some() && self.program.restore_focus {
                self.last_tree = tree.clone();
                let elements = !self.program.schedule.commit_events_ignored;
                for (target, kind, data) in self.focus_events(Some(f)) {
                    let _ = self.dispatch_nested(target, kind, data, elements);
                }
            }
        }
        self.last_tree = tree.clone();
        Ok(tree)
    }

    fn render_instance(
        &mut self,
        id: usize,
        out: &mut Vec<VNode>,
        visited: &mut HashSet<usize>,
    ) -> Res<()> {
        if let Some(updated) = self.render_updates.clone() {
            // Pre effects of an existing instance run before it renders
            // (new instances ran theirs when created).
            if id < updated.len() {
                self.run_phase_at(id, EffectPhase::Pre, &updated);
            }
        }
        let saved = std::mem::replace(&mut self.current, id);
        // The instance's own template is outside the slot content that
        // created it: its children's parent is the instance.
        let via = std::mem::take(&mut self.via);
        let comp = self.comp();
        let frame = Frame::new(comp.template_locals.len());
        let mut path = vec![];
        let r = comp
            .template
            .iter()
            .try_for_each(|n| self.render_node(n, &frame, &mut path, out, visited));
        self.current = saved;
        self.via = via;
        r
    }

    /// A node of fragment `f` (`{@html}`), its elements identified by their
    /// order in the fragment.
    fn fragment_node(
        &mut self,
        node: &FragmentNode,
        base: &InstKey,
        f: usize,
        ordinal: &mut usize,
    ) -> VNode {
        match node {
            FragmentNode::Text { text } => VNode::Text(text.clone()),
            FragmentNode::Element {
                tag,
                attrs,
                children,
            } => {
                *ordinal += 1;
                let key = (base.clone(), (f << 24) + *ordinal);
                let id = match self.element_ids.get(&key) {
                    Some(&id) => id,
                    None => {
                        self.next_element += 1;
                        self.element_ids.insert(key.clone(), self.next_element);
                        self.next_element
                    }
                };
                self.rendered_elements.insert(key);
                let children = children
                    .iter()
                    .map(|c| self.fragment_node(c, base, f, ordinal))
                    .collect();
                VNode::Element {
                    tag: tag.clone(),
                    attrs: attrs.iter().cloned().collect(),
                    value: None,
                    checked: None,
                    id,
                    listeners: vec![],
                    children,
                }
            }
        }
    }

    fn render_node(
        &mut self,
        n: &'p Node,
        frame: &Frame,
        path: &mut Vec<MapKey>,
        out: &mut Vec<VNode>,
        visited: &mut HashSet<usize>,
    ) -> Res<()> {
        match n {
            Node::Text { parts, .. } => {
                let mut text = String::new();
                for p in parts {
                    text.push_str(&self.eval(p, frame)?.string().to_rust());
                }
                out.push(VNode::Text(text));
            }
            Node::Html {
                value, fragments, ..
            } => {
                let html = match self.eval(value, frame)? {
                    Val::Str(s) => s.to_rust(),
                    _ => String::new(),
                };
                if html.is_empty() {
                    return Ok(());
                }
                let program = self.program;
                let Some(&f) = fragments
                    .iter()
                    .find(|&&f| program.fragments[f].html == html)
                else {
                    let what = "{@html} of a string that was not parsed at build time".to_owned();
                    self.unsupported.get_or_insert(what.clone());
                    return Err(Throw::new("RunicUnsupportedError", what));
                };
                // Elements of the fragment keep their identity while the value
                // stays (a new value is new nodes, as Svelte inserts them).
                let mut ordinal = 0;
                let base = InstKey {
                    parent: self.current,
                    node: n as *const Node as usize,
                    path: path.clone(),
                    via: self.via.clone(),
                };
                for node in &program.fragments[f].nodes {
                    let v = self.fragment_node(node, &base, f, &mut ordinal);
                    out.push(v);
                }
            }
            Node::If {
                test,
                then,
                otherwise,
                ..
            } => {
                let body = if self.eval(test, frame)?.boolean() {
                    then
                } else {
                    otherwise
                };
                for c in body {
                    self.render_node(c, frame, path, out, visited)?;
                }
            }
            Node::Each {
                items,
                item,
                index,
                key,
                body,
                otherwise,
                reorder,
                ..
            } => {
                let list_id = (self.current, path.clone(), n as *const Node as usize);
                let previous = self.list_keys.remove(&list_id).unwrap_or_default();
                let mut keys = vec![];
                let mut blocks = vec![];
                let list = self.eval(items, frame)?.array();
                let values: Vec<Val> = list.borrow().clone();
                if values.is_empty() {
                    for c in otherwise {
                        self.render_node(c, frame, path, out, visited)?;
                    }
                }
                let mut seen = HashSet::new();
                for (i, v) in values.into_iter().enumerate() {
                    frame.set(*item, v);
                    if let Some(x) = index {
                        frame.set(*x, Val::Num(i as f64));
                    }
                    let k = match key {
                        Some(k) => self.eval(k, frame)?.map_key(),
                        None => MapKey::Num((i as f64).to_bits()),
                    };
                    if !seen.insert(k.clone()) {
                        return Err(Throw::new("RunicKeyError", "Duplicate key in a keyed list"));
                    }
                    path.push(k.clone());
                    let start = out.len();
                    for c in body {
                        self.render_node(c, frame, path, out, visited)?;
                    }
                    path.pop();
                    blocks.push(start..out.len());
                    keys.push(k);
                }
                // Blocks the framework's keyed diff moves (detaching them).
                if key.is_some() && !previous.is_empty() {
                    let old: Vec<Option<usize>> = keys
                        .iter()
                        .map(|k| previous.iter().position(|p| p == k))
                        .collect();
                    let strategy = match reorder {
                        Reorder::Lis => js::reorder::Reorder::Lis,
                        Reorder::Forward => js::reorder::Reorder::Forward,
                        Reorder::Stash => js::reorder::Reorder::Stash,
                    };
                    let keep = js::reorder::keep(strategy, &old, previous.len());
                    for (j, range) in blocks.into_iter().enumerate() {
                        if old[j].is_some() && !keep[j] {
                            element_ids(&out[range], &mut self.moved);
                        }
                    }
                }
                self.list_keys.insert(list_id, keys);
            }
            Node::Slot {
                name,
                args,
                fallback,
                ..
            } => {
                let decl = self.comp().slot(name).expect("validated slot");
                let provided = self.inst().slots[decl].clone();
                match provided {
                    None => {
                        for c in fallback {
                            self.render_node(c, frame, path, out, visited)?;
                        }
                    }
                    Some(pv) => {
                        let values = args
                            .iter()
                            .map(|a| self.eval(a, frame))
                            .collect::<Res<Vec<_>>>()?;
                        let owner = &self.program.components[self.instances[pv.parent].component];
                        let inner = Frame::new(owner.template_locals.len());
                        for (i, v) in pv.values.into_iter().enumerate() {
                            inner.set(i, v);
                        }
                        for (&l, v) in pv.def.params.iter().zip(values) {
                            inner.set(l, v);
                        }
                        // Content renders in the component that renders it: content
                        // forwarded by slot content renders where that content renders
                        // (Svelte calls the same snippet function there).
                        let child = self.via.last().copied().unwrap_or(self.current);
                        self.via.push(child);
                        let saved = std::mem::replace(&mut self.current, pv.parent);
                        let mut inner_path = path.clone();
                        let r = pv.def.body.iter().try_for_each(|n| {
                            self.render_node(n, &inner, &mut inner_path, out, visited)
                        });
                        self.current = saved;
                        self.via.pop();
                        r?;
                    }
                }
            }
            Node::Component {
                component,
                props,
                slots,
                ..
            } => {
                let child = &self.program.components[*component];
                let mut args = vec![];
                for a in props {
                    let v = self.eval(&a.value, frame)?;
                    let b = match &a.bind {
                        Some(b) => Some(self.eval(b, frame)?),
                        None => None,
                    };
                    args.push((child.prop(&a.name).expect("validated prop"), v, b));
                }
                let key = InstKey {
                    parent: self.current,
                    node: n as *const Node as usize,
                    path: path.clone(),
                    via: self.via.clone(),
                };
                let values: Vec<Val> = (0..self.comp().template_locals.len())
                    .map(|i| frame.get(i))
                    .collect();
                let mut provided: Vec<Option<Provided<'p>>> = vec![];
                for d in &child.slots {
                    let def = slots.iter().find(|s| s.name == d.name);
                    // Forwarded content counts while its condition holds.
                    let given = match def.and_then(|def| def.when.as_ref()) {
                        Some(when) => self.eval(when, frame)?.boolean(),
                        None => def.is_some(),
                    };
                    provided.push(def.filter(|_| given).map(|def| Provided {
                        parent: self.current,
                        def,
                        values: values.clone(),
                    }));
                }
                let id = match self.children.get(&key) {
                    Some(&id) => {
                        for (cell, v, b) in args {
                            let inst = &mut self.instances[id];
                            let changed = match &inst.passed[cell] {
                                Some(old) => !old.same(&v),
                                None => true,
                            };
                            inst.binds[cell] = b;
                            if changed {
                                inst.passed[cell] = Some(v.clone());
                                // Undefined takes the prop's default (Svelte's $props()).
                                let decl = &child.cells[cell];
                                if decl.undefined_default
                                    && matches!(v, Val::Null)
                                    && !matches!(decl.ty, Type::Maybe(_))
                                {
                                    return Err(null_prop(&decl.name));
                                }
                                let v = if decl.undefined_default && matches!(v, Val::Undefined) {
                                    let saved = std::mem::replace(&mut self.current, id);
                                    let d = self.eval(&decl.init, &Frame::new(0));
                                    self.current = saved;
                                    d?
                                } else {
                                    v
                                };
                                let inst = &mut self.instances[id];
                                inst.cells[cell] = v.clone();
                                Rc::make_mut(&mut inst.snapshot)[cell] = v;
                                self.bump(id, cell);
                            }
                        }
                        id
                    }
                    None => {
                        let parent = self.via.last().copied().unwrap_or(self.current);
                        let id = self.create(*component, &args, Some(parent))?;
                        self.children.insert(key, id);
                        id
                    }
                };
                self.instances[id].slots = provided;
                visited.insert(id);
                self.order.push(id);
                self.render_instance(id, out, visited)?;
            }
            Node::Element {
                tag,
                attrs,
                props,
                listeners,
                children,
                reference,
                spread,
                spread_boolean_text,
                classes,
                style_text,
                styles,
                style_update,
                restore: restore_mode,
                adopt,
                ..
            } => {
                let key = (
                    InstKey {
                        parent: self.current,
                        node: n as *const Node as usize,
                        path: path.clone(),
                        via: self.via.clone(),
                    },
                    0,
                );
                let fresh = !self.element_ids.contains_key(&key);
                let id = match self.element_ids.get(&key) {
                    Some(&id) => id,
                    None => {
                        self.next_element += 1;
                        self.element_ids.insert(key.clone(), self.next_element);
                        self.next_element
                    }
                };
                self.rendered_elements.insert(key);
                if let Some(cell) = reference {
                    let current = self.current;
                    let element = Val::Element(js::Element(id));
                    if !self.instances[current].cells[*cell].same(&element) {
                        self.instances[current].cells[*cell] = element.clone();
                        self.ref_changed(current, *cell);
                        self.forward_ref(current, *cell, element)?;
                    }
                    self.refs.insert((current, *cell), id);
                }
                let mut map = BTreeMap::new();
                for a in attrs {
                    match self.eval(&a.value, frame)? {
                        Val::Bool(true) => {
                            map.insert(a.name.clone(), String::new());
                        }
                        Val::Bool(false) | Val::Undefined | Val::Null => {}
                        Val::Str(s) => {
                            map.insert(a.name.clone(), s.to_rust());
                        }
                        other => panic!("validated attribute, found {other:?}"),
                    }
                }
                if !classes.is_empty() {
                    let value = match attrs.iter().find(|a| a.name == "class") {
                        Some(a) => self.eval(&a.value, frame)?.string(),
                        None => JsString::new(),
                    };
                    let mut toggles = vec![];
                    for t in classes {
                        toggles.push(self.eval(&t.value, frame)?.boolean());
                    }
                    let named: Vec<(&str, bool)> = classes
                        .iter()
                        .zip(&toggles)
                        .map(|(t, &on)| (t.name.as_str(), on))
                        .collect();
                    let current = match self.class_states.remove(&id) {
                        Some((v, old, mut current)) if v == value => {
                            for (i, &(name, on)) in named.iter().enumerate() {
                                if old.get(i) != Some(&on) {
                                    if let Some(next) = js::class_toggle(current.as_ref(), name, on)
                                    {
                                        current = Some(next);
                                    }
                                }
                            }
                            current
                        }
                        _ => js::class_compose(&value, &named),
                    };
                    match &current {
                        Some(c) => {
                            map.insert("class".into(), c.to_rust());
                        }
                        None => {
                            map.remove("class");
                        }
                    }
                    self.class_states.insert(id, (value, toggles, current));
                }
                if style_text.is_some() || !styles.is_empty() {
                    let text = |v: Val| match v {
                        Val::Str(s) => Some(s.to_rust()),
                        _ => None,
                    };
                    // Without a style value: properties only (React DOM).
                    let value = match style_text {
                        Some(e) => Some(text(self.eval(e, frame)?)),
                        None => None,
                    };
                    let mut properties = vec![];
                    for p in styles {
                        properties.push((p.name.as_str(), text(self.eval(&p.value, frame)?)));
                    }
                    if *style_update == StyleUpdate::Replace {
                        let (mut state, current) =
                            self.replace_states.remove(&id).unwrap_or_default();
                        let next = match value {
                            Some(value) => state.apply_text(value),
                            None => state.apply_properties(current.as_deref(), &properties),
                        };
                        let current = next.unwrap_or(current);
                        if let Some(c) = &current {
                            map.insert("style".into(), c.clone());
                        }
                        self.replace_states.insert(id, (state, current));
                    } else {
                        let (mut state, current) =
                            self.style_states.remove(&id).unwrap_or_default();
                        let applied = match value {
                            Some(value) => state.apply(current.as_deref(), value, &properties),
                            None => state.apply_properties(current.as_deref(), &properties),
                        };
                        let current = match applied {
                            Ok(next) => next,
                            Err(()) => current,
                        };
                        match &current {
                            Some(c) => {
                                map.insert("style".into(), c.clone());
                            }
                            None => {
                                map.remove("style");
                            }
                        }
                        self.style_states.insert(id, (state, current));
                    }
                }
                let mut refs = vec![];
                // An input's `checked` from a Svelte spread (its property).
                let mut spread_checked = None;
                // A text area's text content from a Svelte spread's defaultValue.
                let mut spread_text = None;
                let mut spread_default = false;
                if let Some(bag) = spread {
                    let Val::Attrs(bag) = self.eval(bag, frame)? else {
                        panic!("validated attribute bag")
                    };
                    let mut attachments = vec![];
                    for (name, v) in resolve_attrs(&bag) {
                        if name.starts_with(js::ATTACHMENT) {
                            attachments.push((name.to_owned(), v.clone()));
                            continue;
                        }
                        // Values Svelte's spread sets otherwise (M6).
                        match (name, v) {
                            ("style", Val::Str(s)) => {
                                // Through the CSSOM (`style.cssText`), when the value changed.
                                let (mut state, current) =
                                    self.style_states.remove(&id).unwrap_or_default();
                                let current =
                                    match state.apply(current.as_deref(), Some(s.to_rust()), &[]) {
                                        Ok(next) => next,
                                        Err(()) => current,
                                    };
                                match &current {
                                    Some(c) => map.insert("style".into(), c.clone()),
                                    None => map.remove("style"),
                                };
                                self.style_states.insert(id, (state, current));
                                continue;
                            }
                            ("style", Val::Record(_) | Val::Map(_)) => {
                                return Err(Throw::new(
                                    "RunicUnsupportedError",
                                    "a style object spread onto an element (set as the string [object Object])",
                                ));
                            }
                            ("hidden", Val::Str(s))
                                if s.to_rust().eq_ignore_ascii_case("until-found") =>
                            {
                                return Err(Throw::new(
                                    "RunicUnsupportedError",
                                    "hidden=\"until-found\" (Blitz has no find-in-page and hides the content)",
                                ));
                            }
                            // Svelte assigns an input's `checked` to its property.
                            ("checked", Val::Bool(b)) if *spread_boolean_text && tag == "input" => {
                                spread_checked = Some(*b);
                                continue;
                            }
                            // Svelte assigns `defaultValue` to the property: an
                            // input's `value` attribute, a text area's text
                            // content; elsewhere an expando.
                            ("defaultValue", _) if *spread_boolean_text => {
                                if tag != "input" && tag != "textarea" {
                                    continue;
                                }
                                let Val::Str(s) = v else {
                                    return Err(Throw::new(
                                        "RunicUnsupportedError",
                                        format!(
                                            "a spread's defaultValue on <{tag}> that is not a string"
                                        ),
                                    ));
                                };
                                let s = s.to_rust();
                                spread_default = true;
                                let previous = self.spread_defaults.insert(id, s.clone());
                                if tag == "input" && previous.is_some_and(|p| p != s) {
                                    return Err(Throw::new(
                                        "RunicUnsupportedError",
                                        "a spread's defaultValue changing on an <input>",
                                    ));
                                }
                                if tag == "input" {
                                    map.insert("value".into(), s);
                                } else {
                                    spread_text = Some(s);
                                }
                                continue;
                            }
                            // An input's `checked` attribute; elsewhere an expando.
                            ("defaultChecked", _) if *spread_boolean_text => {
                                if tag == "input" {
                                    return Err(Throw::new(
                                        "RunicUnsupportedError",
                                        "a spread's defaultChecked on an <input>",
                                    ));
                                }
                                continue;
                            }
                            // Svelte assigns a defined `value` to the element's property.
                            ("value", Val::Str(_) | Val::Bool(_)) if *spread_boolean_text => {
                                match js::spread_value(tag) {
                                    js::SpreadValue::Expando => continue,
                                    js::SpreadValue::Reflect => {}
                                    js::SpreadValue::Unsupported => {
                                        return Err(Throw::new(
                                            "RunicUnsupportedError",
                                            format!(
                                                "a spread's value on <{tag}> (Svelte assigns the value property)"
                                            ),
                                        ));
                                    }
                                }
                                if let Val::Bool(b) = v {
                                    map.insert("value".into(), b.to_string());
                                    continue;
                                }
                            }
                            (n, Val::Bool(b))
                                if *spread_boolean_text && !BOOLEAN_PROPERTIES.contains(&n) =>
                            {
                                map.insert(n.to_ascii_lowercase(), b.to_string());
                                continue;
                            }
                            _ => {}
                        }
                        match EventKind::listener(name) {
                            Some((kind, capture)) => {
                                // (A capture listener: the element's capture
                                // phase list, M6 overlays.)
                                if capture {
                                    self.capture_elements
                                        .entry(id)
                                        .or_default()
                                        .push((kind, self.listeners.len()));
                                } else {
                                    refs.push((kind, self.listeners.len()));
                                }
                                self.listeners.push(ListenerRef {
                                    instance: self.current,
                                    handler: usize::MAX,
                                    args: vec![],
                                    closure: Some(v.clone()),
                                });
                            }
                            // HTML lowercases attribute names.
                            None => match v {
                                Val::Str(s) => {
                                    map.insert(name.to_ascii_lowercase(), s.to_rust());
                                }
                                Val::Bool(true) => {
                                    map.insert(name.to_ascii_lowercase(), String::new());
                                }
                                // A number passed through rest props: its text.
                                Val::Num(n) => {
                                    map.insert(name.to_ascii_lowercase(), js::number_to_string(*n));
                                }
                                Val::Array(_)
                                | Val::Record(_)
                                | Val::Map(_)
                                | Val::Set(_)
                                | Val::Element(_)
                                | Val::Promise(_)
                                | Val::RegExp(_)
                                | Val::MediaQuery(_)
                                | Val::Date(_) => {
                                    return Err(Throw::new(
                                        "RunicUnsupportedError",
                                        "a spread entry that is neither text, a boolean, a number nor a listener, set on an element as its string",
                                    ));
                                }
                                _ => {
                                    map.remove(&name.to_ascii_lowercase());
                                }
                            },
                        }
                    }
                    self.note_attachments(id, attachments);
                }
                if !spread_default && self.spread_defaults.remove(&id).is_some() {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        "a spread no longer holding a defaultValue (Svelte assigns null)",
                    ));
                }
                // A text control adopting its value at mount (Svelte's
                // bind_value with a nullish value): the handler runs for an
                // input event of the value its attributes gave it.
                if let Some(a) = adopt.as_ref().filter(|_| fresh) {
                    if self.eval(&a.when, frame)?.boolean() {
                        let shown = if tag == "textarea" {
                            spread_text.clone().unwrap_or_default()
                        } else {
                            map.get("value").cloned().unwrap_or_default()
                        };
                        if !shown.is_empty() {
                            let args = a
                                .args
                                .iter()
                                .map(|x| self.eval(x, frame))
                                .collect::<Res<Vec<_>>>()?;
                            let event = js::Event::new(js::EventData {
                                kind: JsString::from("input"),
                                value: JsString::from(shown.as_str()),
                                target: js::Element(id),
                                ..Default::default()
                            });
                            self.run(self.current, a.handler, args, Some(event))?;
                            if self.phase.is_some() {
                                self.again = true;
                            }
                        }
                    }
                }
                self.rendered_ids.insert(id);
                let mut value = None;
                let mut checked = None;
                // Controlled values: applied always (restore) or when they change.
                let restore = self.program.schedule.controlled_restore && self.restore_due;
                // A text area's text content (its children).
                let mut text_content = None;
                let restore_render = *restore_mode == Some(Restore::Render);
                // A select value falling back to the first enabled option (React DOM).
                let mut first_enabled = false;
                for p in props {
                    match p.name.as_str() {
                        "defaultValue" => {
                            text_content = Some(self.eval(&p.value, frame)?.string().to_rust());
                        }
                        "value" | "selectValue" => {
                            first_enabled = p.name == "selectValue";
                            let v = self.eval(&p.value, frame)?.string().to_rust();
                            // A re-render of the instance since the value was last applied.
                            let renders = self.instances[self.current].renders;
                            let rerendered = restore_render
                                && self
                                    .control_renders
                                    .insert(id, renders)
                                    .is_some_and(|r| r != renders);
                            let cache = self.control_cache.entry(id).or_default();
                            if restore || rerendered || cache.0.as_ref() != Some(&v) {
                                cache.0 = Some(v.clone());
                                self.live_values.insert(id, v);
                            }
                            value = self.live_values.get(&id).cloned();
                        }
                        "checked" => {
                            let v = self.eval(&p.value, frame)?.boolean();
                            let cache = self.control_cache.entry(id).or_default();
                            if restore || cache.1 != Some(v) {
                                cache.1 = Some(v);
                                self.live_checked.insert(id, v);
                                // Checking a radio button unchecks its group
                                // (after this render, which knows the group).
                                let radio = tag == "input"
                                    && map
                                        .get("type")
                                        .is_some_and(|t| t.eq_ignore_ascii_case("radio"));
                                if v && radio {
                                    self.checked_radios.push(id);
                                }
                            }
                            checked = self.live_checked.get(&id).copied();
                            // A checkbox's value property defaults to "on".
                            value = Some(map.get("value").cloned().unwrap_or_else(|| "on".into()));
                        }
                        _ => {}
                    }
                }
                if let (Some(b), None) = (spread_checked, checked) {
                    // Assigned when it changed, as Svelte's set_attributes does.
                    let cache = self.control_cache.entry(id).or_default();
                    if cache.1 != Some(b) {
                        cache.1 = Some(b);
                        self.live_checked.insert(id, b);
                    }
                    checked = self.live_checked.get(&id).copied();
                    if value.is_none() {
                        value = Some(map.get("value").cloned().unwrap_or_else(|| "on".into()));
                    }
                }
                // An uncontrolled checkbox or radio button keeps what the user
                // toggled; until then its checkedness is the presence of its
                // `checked` attribute (the default checkedness).
                if checked.is_none()
                    && tag == "input"
                    && map.get("type").is_some_and(|t| {
                        t.eq_ignore_ascii_case("checkbox") || t.eq_ignore_ascii_case("radio")
                    })
                {
                    checked = Some(
                        self.live_checked
                            .get(&id)
                            .copied()
                            .unwrap_or_else(|| map.contains_key("checked")),
                    );
                    if value.is_none() {
                        value = Some(map.get("value").cloned().unwrap_or_else(|| "on".into()));
                    }
                }
                // An uncontrolled text input shows what was typed, initially its
                // `value` attribute.
                if value.is_none() && checked.is_none() && (tag == "input" || tag == "textarea") {
                    value = Some(
                        self.live_values
                            .get(&id)
                            .cloned()
                            .or_else(|| spread_text.clone().filter(|_| tag == "textarea"))
                            .or_else(|| map.get("value").cloned())
                            .unwrap_or_default(),
                    );
                }
                for l in listeners {
                    let args = l
                        .args
                        .iter()
                        .map(|a| self.eval(a, frame))
                        .collect::<Res<Vec<_>>>()?;
                    refs.push((l.event, self.listeners.len()));
                    self.listeners.push(ListenerRef {
                        instance: self.current,
                        handler: l.handler,
                        args,
                        closure: None,
                    });
                }
                let mut kids = vec![];
                for c in children {
                    self.render_node(c, frame, path, &mut kids, visited)?;
                }
                // An element without template children (rule O3a, M6 script
                // DOM): script owns its child list.
                // Attributes script wrote (slice 2): the framework writing a
                // changed value that differs from script's is unsupported.
                if let Some(overlay) = self.script.attrs.get_mut(&id) {
                    for (name, (value, framework)) in overlay.iter_mut() {
                        let now = map.get(name).cloned();
                        if now != *framework {
                            if now != *value {
                                let what = format!(
                                    "the framework writing attribute {name}, which script set to another value (the frameworks skip writes of values they set before)"
                                );
                                self.unsupported.get_or_insert(what);
                            }
                            *framework = now.clone();
                            *value = now;
                        }
                        match value {
                            Some(v) => {
                                map.insert(name.clone(), v.clone());
                            }
                            None => {
                                map.remove(name);
                            }
                        }
                    }
                }
                if children.is_empty() && script_host_tag(tag) {
                    self.script_hosts.insert(id);
                    if let Some(list) = self.script.hosts.get(&id) {
                        kids.extend(list.iter().filter_map(|&c| self.script.vnode(c)));
                    }
                }
                if let Some(t) = text_content.or(spread_text) {
                    kids.push(VNode::Text(t));
                }
                // A select's value is its shown option's: the controlled value
                // if an option has it (else none: ""); uncontrolled, the chosen
                // option while it is there, else the first enabled one.
                if tag == "select" {
                    let options: Vec<(String, bool)> = kids
                        .iter()
                        .filter_map(|k| match k {
                            VNode::Element {
                                tag,
                                attrs,
                                children,
                                ..
                            } if tag == "option" => Some((
                                attrs.get("value").cloned().unwrap_or_else(|| {
                                    collapse_ascii_whitespace(
                                        &children.iter().map(text_of).collect::<String>(),
                                    )
                                }),
                                attrs.contains_key("disabled"),
                            )),
                            _ => None,
                        })
                        .collect();
                    let has = |v: &str| options.iter().any(|(o, _)| o == v);
                    let shown = match value.take() {
                        Some(v) if has(&v) => Some(v),
                        // React DOM's updateOptions: else the first enabled
                        // option, else the selection unchanged.
                        Some(_) if first_enabled => options
                            .iter()
                            .find(|o| !o.1)
                            .map(|o| o.0.clone())
                            .or_else(|| self.select_shown.get(&id).filter(|v| has(v)).cloned()),
                        Some(_) => None,
                        None => self
                            .live_values
                            .get(&id)
                            .filter(|v| has(v))
                            .cloned()
                            .or_else(|| options.iter().find(|o| !o.1).map(|o| o.0.clone())),
                    };
                    if first_enabled {
                        match &shown {
                            Some(s) => self.select_shown.insert(id, s.clone()),
                            None => self.select_shown.remove(&id),
                        };
                    }
                    value = Some(shown.unwrap_or_default());
                }
                out.push(VNode::Element {
                    tag: tag.clone(),
                    attrs: map,
                    value,
                    checked,
                    id,
                    listeners: refs,
                    children: normalize(kids),
                });
            }
        }
        Ok(())
    }

    // --- Script DOM (M6, docs/design/M6-SCRIPT-DOM.md) ---

    /// The id of a rendered element `v` holds (in the last rendered tree,
    /// not one script created), if it is one.
    fn rendered_element(&self, v: &Val) -> Option<u64> {
        let Val::Element(e) = v else { return None };
        if self.script.is_script(e.0) || !e.is_element() {
            return None;
        }
        chain_nodes(&self.last_tree, e.0).map(|_| e.0)
    }

    /// Script writing attribute `name` of rendered element `id` (none:
    /// removing it): kept over the framework's value until the framework
    /// writes a changed one (see the render).
    fn script_attr(&mut self, id: u64, name: &str, value: Option<String>) {
        let framework = match chain_nodes(&self.last_tree, id).and_then(|c| c.last().copied()) {
            Some(VNode::Element { attrs, .. }) => attrs.get(name).cloned(),
            _ => None,
        };
        let overlay = self.script.attrs.entry(id).or_default();
        let entry = overlay.entry(name.to_owned()).or_insert((None, framework));
        entry.0 = value;
        self.regraft();
    }

    /// The id of a script-created element `v` holds, if it is one.
    fn script_element(&self, v: &Val) -> Option<u64> {
        let Val::Element(e) = v else { return None };
        match self.script.nodes.get(&e.0)?.kind {
            ScriptKind::Element { .. } => Some(e.0),
            ScriptKind::Text(_) | ScriptKind::Comment(_) | ScriptKind::Fragment => None,
        }
    }

    /// The child list of node `v` that script may change: a script node's,
    /// a rendered element's without template children (rule O3a), or the
    /// body's before the container. Other rendered elements need the
    /// native DOM.
    fn script_parent(&self, v: &Val, method: &str) -> Res<ScriptParent> {
        let Val::Element(e) = v else {
            panic!("validated element")
        };
        if *e == js::Element::WINDOW || *e == js::Element::VISUAL_VIEWPORT {
            return Err(Throw::new(
                "TypeError",
                format!(
                    "Failed to execute '{method}' on 'Node': parameter 1 is not of type 'Node'."
                ),
            ));
        }
        if self.script.is_script(e.0) {
            return Ok(ScriptParent::Node(e.0));
        }
        if *e == js::Element::BODY {
            return Ok(ScriptParent::Body);
        }
        if self.script_hosts.contains(&e.0) {
            return Ok(ScriptParent::Host(e.0));
        }
        Err(Throw::new(
            "RunicLayoutError",
            format!(
                "{method} of the children of a rendered element needs the native DOM, which the interpreter does not have"
            ),
        ))
    }

    /// The DOM standard's pre-insertion validity and the ownership rules
    /// (as the native runtime's `Host::check_insert`).
    fn script_check_insert(
        &self,
        parent: ScriptParent,
        node: &Val,
        before: Option<js::Element>,
        method: &str,
    ) -> Res<()> {
        let Val::Element(n) = node else {
            panic!("validated element")
        };
        let hierarchy = |m: &str| {
            Err(Throw::new(
                "HierarchyRequestError",
                format!("Failed to execute '{method}' on 'Node': {m}"),
            ))
        };
        if let ScriptParent::Node(p) = parent {
            if matches!(
                self.script.nodes[&p].kind,
                ScriptKind::Text(_) | ScriptKind::Comment(_)
            ) {
                return hierarchy("This node type does not support this method.");
            }
            if self.script.inclusive_ancestor(n.0, p) {
                return hierarchy("The new child element contains the parent.");
            }
        }
        if let Some(b) = before {
            let ok = match parent {
                ScriptParent::Body => b == CONTAINER || self.script.preceding.contains(&b.0),
                ScriptParent::Node(p) => self.script.nodes[&p].children.contains(&b.0),
                ScriptParent::Host(h) => {
                    self.script.hosts.get(&h).is_some_and(|l| l.contains(&b.0))
                }
            };
            if !ok {
                return Err(Throw::new(
                    "NotFoundError",
                    format!(
                        "Failed to execute '{method}' on 'Node': The node before which the new node is to be inserted is not a child of this node."
                    ),
                ));
            }
        }
        if !self.script.is_script(n.0) {
            return Err(Throw::new(
                "RunicLayoutError",
                format!(
                    "{method} of a rendered node needs the native DOM, which the interpreter does not have"
                ),
            ));
        }
        if parent == ScriptParent::Body && before.is_none() {
            return Err(Throw::new(
                "RunicLayoutError",
                format!(
                    "{method} after the container: the interpreter models the body's script content before the container only"
                ),
            ));
        }
        Ok(())
    }

    fn script_insert(
        &mut self,
        parent: &Val,
        node: &Val,
        before: Option<js::Element>,
        method: &str,
    ) -> Res<()> {
        let p = self.script_parent(parent, method)?;
        let Val::Element(n) = node else {
            panic!("validated element")
        };
        self.script_insert_ids(p, &[n.0], before, method)
    }

    /// Insert nodes `ids` (a fragment standing for its children) into the
    /// child list `p` before `before` (appended without one), after the
    /// pre-insertion validity and ownership checks; a reference among the
    /// nodes moved is replaced by its next sibling that is not.
    fn script_insert_ids(
        &mut self,
        p: ScriptParent,
        ids: &[u64],
        before: Option<js::Element>,
        method: &str,
    ) -> Res<()> {
        for &id in ids {
            if matches!(
                self.script.nodes.get(&id).map(|n| &n.kind),
                Some(ScriptKind::Fragment)
            ) && matches!(p, ScriptParent::Node(q) if self.script.inclusive_ancestor(id, q))
            {
                return Err(Throw::new(
                    "HierarchyRequestError",
                    format!(
                        "Failed to execute '{method}' on 'Node': The new child element contains the parent."
                    ),
                ));
            }
        }
        let ids = self.script.expand(ids);
        let mut before = before;
        if let Some(b) = before.filter(|b| ids.contains(&b.0)) {
            let list = self.script_list(p);
            before = list
                .iter()
                .position(|&s| s == b.0)
                .and_then(|at| js::script_dom::viable_sibling(&list, at, true, &ids))
                .map(js::Element)
                .or(if p == ScriptParent::Body {
                    Some(CONTAINER)
                } else {
                    None
                });
        }
        for &id in &ids {
            self.script_check_insert(p, &Val::Element(js::Element(id)), before, method)?;
        }
        let before = before.filter(|b| *b != CONTAINER).map(|b| b.0);
        for id in ids {
            self.script.insert(p, id, before);
        }
        self.regraft();
        Ok(())
    }

    /// The child list `p` (the body's: its script nodes, then the container).
    fn script_list(&mut self, p: ScriptParent) -> Vec<u64> {
        let mut list = self.script.list_mut(p).clone();
        if p == ScriptParent::Body {
            list.push(CONTAINER.0);
        }
        list
    }

    /// The parent and the child list of script node `id` (none detached).
    fn script_siblings(&mut self, id: u64) -> Option<(ScriptParent, Vec<u64>)> {
        let parent = self.script.nodes.get(&id)?.parent?;
        Some((parent, self.script_list(parent)))
    }

    /// Show the current script children of rendered elements without
    /// template children in the last rendered tree, so that reads of it
    /// see script's changes before the next render.
    fn regraft(&mut self) {
        fn walk(nodes: &mut [VNode], script: &ScriptDom, hosts: &HashSet<u64>) {
            for n in nodes {
                if let VNode::Element {
                    id,
                    children,
                    attrs,
                    ..
                } = n
                {
                    for (name, (value, _)) in script.attrs.get(id).into_iter().flatten() {
                        match value {
                            Some(v) => {
                                attrs.insert(name.clone(), v.clone());
                            }
                            None => {
                                attrs.remove(name);
                            }
                        }
                    }
                    if hosts.contains(id) {
                        *children = script
                            .hosts
                            .get(id)
                            .map(|l| l.iter().filter_map(|&c| script.vnode(c)).collect())
                            .unwrap_or_default();
                    } else {
                        walk(children, script, hosts);
                    }
                }
            }
        }
        let mut tree = std::mem::take(&mut self.last_tree);
        walk(&mut tree, &self.script, &self.script_hosts);
        self.last_tree = tree;
    }

    /// The tree of script node `id` (its outermost script ancestor's), for
    /// reads of a node that the rendered tree does not hold: one before the
    /// container, or one not in the document.
    fn script_tree(&self, id: u64) -> Option<Vec<VNode>> {
        if !self.script.is_script(id) {
            return None;
        }
        let mut top = id;
        while let Some(ScriptParent::Node(p)) = self.script.nodes[&top].parent {
            top = p;
        }
        match self.script.nodes[&top].parent {
            // (Inside a rendered element: the rendered tree holds it.)
            Some(ScriptParent::Host(_)) => None,
            _ => Some(self.script.vnode(top).into_iter().collect()),
        }
    }

    /// The tree holding node `id`: its script tree outside the rendered
    /// tree, or the rendered tree.
    fn tree_for(&self, id: u64) -> std::borrow::Cow<'_, [VNode]> {
        match self.script_tree(id) {
            Some(t) => std::borrow::Cow::Owned(t),
            None => std::borrow::Cow::Borrowed(&self.last_tree),
        }
    }

    /// Cells of the root instance and the DOM; other live instances follow in
    /// tree order under `instances` (omitted when there are none).
    pub fn snapshot(&mut self) -> Json {
        let mut portals = vec![];
        let dom = match self.render() {
            Ok(d) => {
                // Content mounted in the body (M6) follows the root's.
                portals = d[self.root_len..].iter().map(VNode::to_json).collect();
                Json::Array(d[..self.root_len].iter().map(VNode::to_json).collect())
            }
            Err(e) => json!({ "error": e.to_string() }),
        };
        let cells: Vec<Json> = self.instances[0].cells.iter().map(cell_json).collect();
        let mut state = json!({ "cells": cells, "dom": dom });
        if !portals.is_empty() {
            state["portals"] = Json::Array(portals);
        }
        // Script content in the body before the container (M6 script DOM).
        if !self.script.preceding.is_empty() {
            let nodes = self
                .script
                .preceding
                .iter()
                .filter_map(|&c| self.script.vnode(c))
                .collect();
            state["preceding"] = Json::Array(normalize(nodes).iter().map(VNode::to_json).collect());
        }
        if !self.root.attrs().is_empty() {
            state["document"] = json!(self.root.attrs());
        }
        if !self.body.attrs().is_empty() {
            state["body"] = json!(self.body.attrs());
        }
        // Host effects (console lines since the last snapshot, the
        // clipboard, the location and the history length), without defaults.
        let mut host = Map::new();
        let lines = std::mem::take(&mut self.host.console);
        if !lines.is_empty() {
            let lines: Vec<Json> = lines
                .iter()
                .map(|(level, text)| json!({ "level": level, "text": text_json(text) }))
                .collect();
            host.insert("console".into(), Json::Array(lines));
        }
        if !self.host.clipboard.is_empty() {
            host.insert("clipboard".into(), text_json(&self.host.clipboard));
        }
        let href = self.host.session.href();
        if href != "/" {
            host.insert("href".into(), json!(href));
        }
        if self.host.session.length() != 1 {
            host.insert("historyLength".into(), json!(self.host.session.length()));
        }
        let title = js::history::document_title(&self.host.title);
        if !title.is_empty() {
            host.insert("title".into(), text_json(&title));
        }
        if !host.is_empty() {
            state["host"] = Json::Object(host);
        }
        if !self.order.is_empty() {
            state["instances"] = Json::Array(
                self.order
                    .iter()
                    .map(|&id| {
                        let i = &self.instances[id];
                        json!({
                            "component": self.program.components[i.component].name,
                            "cells": i.cells.iter().map(cell_json).collect::<Vec<_>>(),
                        })
                    })
                    .collect(),
            );
        }
        state
    }

    /// Run a task (event listeners or a timer callback), then its microtask
    /// checkpoint and the default tasks it queued. Writes made before an
    /// exception persist (as in JavaScript); text-domain violations reject the
    /// whole task.
    fn task(
        &mut self,
        source: Option<&Source>,
        event: bool,
        body: impl FnOnce(&mut Self) -> Res<()>,
    ) -> Result<()> {
        let before: Vec<Vec<Val>> = self.instances.iter().map(|i| i.cells.clone()).collect();
        self.tasks_run += 1;
        self.in_event = event;
        self.dispatching = event;
        let result = body(self);
        self.dispatching = false;
        self.payload = None;
        if let Err(t) = &result {
            if t.name.to_rust() == "RunicDomainError" {
                for (i, cells) in self.instances.iter_mut().zip(before) {
                    i.cells = cells;
                }
                self.microtasks.clear();
                self.flush_pending = false;
                self.in_event = false;
                return Err(Diagnostic::new("E_TEXT_PAYLOAD", t.message.to_rust(), None));
            }
        }
        self.checkpoint();
        self.in_event = false;
        while let Some(job) = self.default_tasks.pop_front() {
            self.run_micro(job);
            self.checkpoint();
        }
        // React restores controlled values after the listeners of each
        // event, also when they wrote no state (the runtime syncs then); a
        // render error shows at the next render.
        if event && self.program.schedule.controlled_restore {
            self.restore_due = true;
            let _ = self.render();
        }
        self.late_rejection_handlers();
        let uncaught = std::mem::take(&mut self.uncaught);
        if let Some(what) = self.unsupported.take() {
            return Err(Diagnostic::new(
                "E_UNSUPPORTED",
                format!("unsupported: {what}"),
                source,
            ));
        }
        match (result, uncaught.into_iter().next()) {
            (Err(t), _) | (Ok(()), Some(t)) => {
                Err(Diagnostic::new("E_THROW", t.to_string(), source))
            }
            (Ok(()), None) => Ok(()),
        }
    }

    /// Queue the flush job if none is pending.
    fn queue_flush(&mut self) {
        if let Some(phase) = self.phase {
            // Writes from effects: another pass of the running flush, or a
            // later flush where post-effect writes are deferred.
            if phase == EffectPhase::Post && self.program.schedule.post_writes_deferred {
                if !self.flush_pending {
                    self.flush_pending = true;
                    self.default_tasks.push_back(Micro::Flush);
                }
            } else {
                self.again = true;
            }
            return;
        }
        if self.flush_pending {
            // A discrete update renders in its microtask, with the updates
            // that wait for a default-priority task (React's sync render
            // takes the pending default and continuous lanes).
            if self.program.schedule.flush == Flush::EventMicrotask && self.dispatching {
                if let Some(i) = self
                    .default_tasks
                    .iter()
                    .position(|j| matches!(j, Micro::Flush))
                {
                    self.default_tasks.remove(i);
                    self.microtasks.push_back(Micro::Flush);
                }
            }
            return;
        }
        self.flush_pending = true;
        match self.program.schedule.flush {
            Flush::EventMicrotask if !self.in_event => self.default_tasks.push_back(Micro::Flush),
            _ => self.microtasks.push_back(Micro::Flush),
        }
    }

    /// Queue the flush job if tracked heap values were mutated since the last
    /// flush. Checked before anything else is queued, which orders the flush
    /// exactly as if it had been queued at the mutation.
    fn note_mutations(&mut self) {
        let (deep, owned) = self.epochs;
        if (self.tracks_deep && js::mutation_epoch() != deep)
            || (self.tracks_owned && js::owned_epoch() != owned)
        {
            self.queue_flush();
        }
    }

    fn queue_micro(&mut self, callback: Val) {
        self.enqueue(Micro::Call(callback));
    }

    /// Run microtasks until none are left; the rejections they left without
    /// a reaction are reported by a default task.
    fn checkpoint(&mut self) {
        self.note_mutations();
        while let Some(job) = self.microtasks.pop_front() {
            self.run_micro(job);
            self.note_mutations();
        }
        let r = js::take_rejections();
        if !r.is_empty() {
            self.default_tasks.push_back(Micro::Report(r));
        }
    }

    /// A handler added to a promise after its rejection was reported:
    /// Chromium revokes the report, which console lines do not model.
    fn late_rejection_handlers(&mut self) {
        if let Some(t) = js::take_late_handled() {
            self.unsupported.get_or_insert(format!(
                "a handler added to a promise after its rejection ({t}) was reported as unhandled"
            ));
        }
    }

    fn run_micro(&mut self, job: Micro) {
        match job {
            Micro::Call(f) => {
                if let Err(t) = self.call_value(&f, vec![]) {
                    self.uncaught.push(t);
                }
            }
            Micro::Flush => self.flush(),
            Micro::Tick(p) => {
                if self.flush_pending {
                    self.microtasks.retain(|j| !matches!(j, Micro::Flush));
                    self.default_tasks.retain(|j| !matches!(j, Micro::Flush));
                    self.flush();
                }
                self.settle_promise(&p, Ok(Val::Undefined));
            }
            Micro::Promise(job) => self.promise_job(job),
            Micro::Report(r) => {
                for t in r.report() {
                    self.host.console.push(("error", js::rejection_line(&t)));
                }
            }
        }
    }

    // Promises --------------------------------------------------------------------

    /// Queue a microtask (after a flush the pending writes ask for).
    fn enqueue(&mut self, job: Micro) {
        self.note_mutations();
        self.microtasks.push_back(job);
    }

    fn settle_promise(&mut self, p: &Promise, outcome: Res<Val>) {
        for job in p.settle(outcome) {
            self.enqueue(Micro::Promise(job));
        }
    }

    /// Resolve `p` with `v`: a promise is adopted (one job to subscribe, one
    /// for its reaction), anything else fulfils.
    fn resolve_promise(&mut self, p: &Promise, v: Val) {
        match v {
            Val::Promise(q) if q == *p => self.settle_promise(
                p,
                Err(Throw::new(
                    "TypeError",
                    "Chaining cycle detected for promise",
                )),
            ),
            Val::Promise(q) => self.enqueue(Micro::Promise(PJob::Adopt {
                promise: p.clone(),
                thenable: q,
            })),
            other => self.settle_promise(p, Ok(other)),
        }
    }

    /// Register `handler` on `p` for the promise `derived`.
    fn react(&mut self, p: &Promise, handler: PHandler, derived: Promise) {
        let mut handler = Some(handler);
        let reaction = Box::new(move |outcome| PJob::Reaction {
            outcome,
            handler: handler.take().expect("one reaction"),
            derived,
        });
        if let Some(job) = p.react(reaction) {
            self.enqueue(Micro::Promise(job));
        }
    }

    fn error_value(&self, t: Throw) -> Val {
        Val::Record(JsRef::new(RecordData::new(
            self.error_record(),
            vec![Val::Str(t.name), Val::Str(t.message)],
            false,
        )))
    }

    /// A promise reaction threw: its derived promise rejects. A limitation
    /// of the interpreter (no layout, an unsupported shape) is also reported
    /// as uncaught, so that a run never passes on it silently.
    fn reaction_failed(&mut self, derived: &Promise, t: Throw) {
        if matches!(
            t.name.to_rust().as_str(),
            "RunicLayoutError" | "RunicUnsupportedError"
        ) {
            self.uncaught.push(t.clone());
        }
        self.settle_promise(derived, Err(t));
    }

    fn promise_job(&mut self, job: PJob) {
        match job {
            PJob::Adopt { promise, thenable } => {
                self.react(&thenable, PHandler::Then(None, None), promise);
            }
            PJob::Reaction {
                outcome,
                handler,
                derived,
            } => match handler {
                PHandler::Then(on_fulfilled, on_rejected) => {
                    let (h, arg) = match outcome {
                        Ok(v) => (on_fulfilled, Ok(v)),
                        Err(t) => (on_rejected, Err(t)),
                    };
                    match (h, arg) {
                        (None, Ok(v)) => self.resolve_promise(&derived, v),
                        (None, Err(t)) => self.settle_promise(&derived, Err(t)),
                        (Some(h), arg) => {
                            let arg = arg.unwrap_or_else(|t| self.error_value(t));
                            match self.call_value(&h, vec![arg]) {
                                Ok(v) => self.resolve_promise(&derived, v),
                                Err(t) => self.reaction_failed(&derived, t),
                            }
                        }
                    }
                }
                // thenFinally/catchFinally: run the callback, then settle with
                // the original outcome once its result settles.
                PHandler::Finally(f) => match self.call_value(&f, vec![]) {
                    Err(t) => self.reaction_failed(&derived, t),
                    Ok(r) => {
                        let p = match r {
                            Val::Promise(p) => p,
                            other => Promise::fulfilled(other),
                        };
                        let after = Promise::pending();
                        let original = outcome;
                        let mut original = Some(original);
                        let target = after.clone();
                        let reaction = Box::new(move |po: Res<Val>| PJob::Reaction {
                            outcome: match po {
                                Ok(_) => original.take().expect("one reaction"),
                                Err(t) => Err(t),
                            },
                            handler: PHandler::Then(None, None),
                            derived: target,
                        });
                        if let Some(job) = p.react(reaction) {
                            self.enqueue(Micro::Promise(job));
                        }
                        self.resolve_promise(&derived, Val::Promise(after));
                    }
                },
                PHandler::All(state, index) => match outcome {
                    Ok(v) => {
                        state.values.borrow_mut()[index] = v;
                        state.remaining.set(state.remaining.get() - 1);
                        if state.remaining.get() == 0 {
                            let values = state.values.borrow().clone();
                            self.resolve_promise(&derived, Val::Array(js::array(values)));
                        }
                    }
                    Err(t) => self.settle_promise(&derived, Err(t)),
                },
            },
        }
    }

    fn promise_builtin(&mut self, method: &str, a: Vec<Val>) -> Res<Val> {
        let promise_of = |v: &Val| match v {
            Val::Promise(p) => p.clone(),
            other => panic!("validated promise, found {other:?}"),
        };
        Ok(match method {
            "new" => {
                let p = Promise::pending();
                let done = Rc::new(std::cell::Cell::new(false));
                let resolver = |reject| {
                    Val::Resolver(Rc::new(Resolver {
                        promise: p.clone(),
                        reject,
                        done: done.clone(),
                    }))
                };
                let (resolve, reject) = (resolver(false), resolver(true));
                if let Err(t) = self.call_value(&a[0], vec![resolve, reject]) {
                    if !done.replace(true) {
                        self.settle_promise(&p, Err(t));
                    }
                }
                Val::Promise(p)
            }
            "resolve" => match &a[0] {
                Val::Promise(p) => Val::Promise(p.clone()),
                other => Val::Promise(Promise::fulfilled(other.clone())),
            },
            "reject" => Val::Promise(Promise::rejected(throw_of(&a[0]))),
            "then" => {
                let derived = Promise::pending();
                let handler = PHandler::Then(Some(a[1].clone()), a.get(2).cloned());
                self.react(&promise_of(&a[0]), handler, derived.clone());
                Val::Promise(derived)
            }
            "catch" => {
                let derived = Promise::pending();
                let handler = PHandler::Then(None, Some(a[1].clone()));
                self.react(&promise_of(&a[0]), handler, derived.clone());
                Val::Promise(derived)
            }
            "finally" => {
                let derived = Promise::pending();
                self.react(
                    &promise_of(&a[0]),
                    PHandler::Finally(a[1].clone()),
                    derived.clone(),
                );
                Val::Promise(derived)
            }
            "all" => {
                let items = a[0].array().borrow().clone();
                let derived = Promise::pending();
                let state = Rc::new(AllState {
                    values: RefCell::new(vec![Val::Undefined; items.len()]),
                    remaining: std::cell::Cell::new(items.len()),
                });
                if items.is_empty() {
                    self.resolve_promise(&derived, Val::Array(js::array(vec![])));
                }
                for (i, item) in items.iter().enumerate() {
                    let p = promise_of(item);
                    self.react(&p, PHandler::All(state.clone(), i), derived.clone());
                }
                Val::Promise(derived)
            }
            "pending" => Val::Promise(Promise::pending()),
            "fulfil" => {
                self.settle_promise(&promise_of(&a[0]), Ok(a[1].clone()));
                Val::Undefined
            }
            "adopt" => {
                self.resolve_promise(&promise_of(&a[0]), a[1].clone());
                Val::Undefined
            }
            "fail" => {
                self.settle_promise(&promise_of(&a[0]), Err(throw_of(&a[1])));
                Val::Undefined
            }
            other => unreachable!("validated promise operation {other}"),
        })
    }

    /// The flush job: passes that commit the state (render snapshots), run
    /// pre effects, update the tree (creating and destroying instances), and
    /// run layout and post effects, until effects stop writing.
    fn flush(&mut self) {
        self.flush_pending = false;
        for pass in 0.. {
            if pass == 1000 {
                self.uncaught.push(Throw::new(
                    "Error",
                    "Maximum update depth exceeded: effects keep writing state",
                ));
                break;
            }
            self.again = false;
            self.flush_pass();
            self.note_mutations_in_flush();
            if !self.again {
                break;
            }
        }
        self.phase = None;
        self.epochs = (js::mutation_epoch(), js::owned_epoch());
        if let Some(p) = self.flush_promise.take() {
            self.settle_promise(&p, Ok(Val::Undefined));
        }
    }

    /// Heap mutations made by effects extend the flush like cell writes.
    fn note_mutations_in_flush(&mut self) {
        let (deep, owned) = self.epochs;
        if (self.tracks_deep && js::mutation_epoch() != deep)
            || (self.tracks_owned && js::owned_epoch() != owned)
        {
            self.epochs = (js::mutation_epoch(), js::owned_epoch());
            self.phase.get_or_insert(EffectPhase::Pre);
            self.queue_flush();
        }
    }

    fn flush_pass(&mut self) {
        // Instances whose state changed, and (React) everything they render.
        let (deep, owned) = self.epochs;
        let mutated = (js::mutation_epoch() != deep, js::owned_epoch() != owned);
        self.epochs = (js::mutation_epoch(), js::owned_epoch());
        let before: Vec<usize> = self.tree_order();
        let mut updated = vec![false; self.instances.len()];
        for &i in &before {
            let inst = &self.instances[i];
            let comp = &self.program.components[inst.component];
            let changed = inst.cells.iter().enumerate().any(|(c, v)| {
                comp.cells[c].tracking != Tracking::None && !v.same(&inst.snapshot[c])
                    || match comp.cells[c].tracking {
                        Tracking::Deep => mutated.0,
                        Tracking::Proxied => mutated.1,
                        _ => false,
                    }
            });
            updated[i] = changed || inst.parent.is_some_and(|p| updated[p]);
        }
        for i in &mut self.instances {
            if i.alive {
                i.previous = std::mem::replace(&mut i.snapshot, Rc::new(i.cells.clone()));
            }
        }
        self.phase = Some(EffectPhase::Pre);
        let alive_before: Vec<usize> = before.clone();
        self.render_updates = Some(updated.clone());
        self.restore_due = true;
        let rendered = self.render();
        self.render_updates = None;
        if let Err(d) = rendered {
            self.uncaught.push(Throw::new("Error", d.message));
        }
        // Mutations while rendering are not writes.
        self.epochs = (js::mutation_epoch(), js::owned_epoch());
        let destroyed: Vec<usize> = alive_before
            .iter()
            .copied()
            .filter(|&i| !self.instances[i].alive)
            .collect();
        let batched = self.program.schedule.cleanups == Cleanups::Batched;
        // Attachments the render removed are cleaned up as Svelte destroys them.
        self.run_detached();
        // Batched cleanups of destroyed instances join their phase's walk
        // below; the rest run at removal.
        self.teardown(&destroyed, &before, batched);
        let after = self.tree_order();
        let mut updated = updated;
        updated.resize(self.instances.len(), true);
        let post = post_order(&after, &self.instances);
        let destroyed: HashSet<usize> = destroyed.into_iter().collect();
        for phase in [EffectPhase::Layout, EffectPhase::Post] {
            self.phase = Some(phase);
            if batched && phase == EffectPhase::Post {
                for &i in &post {
                    self.run_attachments(i);
                }
            }
            if batched {
                let all: Vec<(usize, usize)> = post
                    .iter()
                    .flat_map(|&i| self.effects_of(i, phase).into_iter().map(move |e| (i, e)))
                    .collect();
                let mut due = vec![];
                for (i, e) in all {
                    if self.effect_due(i, e, &updated) {
                        due.push((i, e));
                    }
                }
                let roots: Vec<usize> = after
                    .iter()
                    .copied()
                    .filter(|i| {
                        !self.instances[*i]
                            .parent
                            .is_some_and(|p| after.contains(&p))
                    })
                    .collect();
                for r in roots {
                    self.batched_cleanups(r, phase, &due, &after, &destroyed, &before);
                }
                for &(i, e) in &due {
                    self.run_effect(i, e);
                }
            } else {
                for &i in &post {
                    // New attachments of the instance's elements run first.
                    if phase == EffectPhase::Post {
                        self.run_attachments(i);
                    }
                    self.run_phase_at(i, phase, &updated);
                }
            }
        }
        // Effect roots after the instances (Svelte processes a root queued
        // during the flush after those already queued).
        self.run_roots();
    }

    /// Live instances in tree order (parent first).
    fn tree_order(&self) -> Vec<usize> {
        std::iter::once(0)
            .chain(self.order.iter().copied())
            .filter(|&i| self.instances[i].alive)
            .collect()
    }

    fn effects_of(&self, i: usize, phase: EffectPhase) -> Vec<usize> {
        (0..self.instances[i].effects.len())
            .filter(|&e| self.effect_at(i, e).phase == phase)
            .collect()
    }

    /// The attachments a spread gives element `element` in this render:
    /// those with the same key and function stay; the others are cleaned up
    /// after the render; new ones run with the post effects of the instance
    /// rendering the element (Svelte runs attachments as effects).
    fn note_attachments(&mut self, element: u64, now: Vec<(String, Val)>) {
        let mut old = self.attached.remove(&element).unwrap_or_default();
        let mut next = vec![];
        for (key, function) in now {
            match old
                .iter()
                .position(|a| a.key == key && a.function.same(&function))
            {
                Some(i) => next.push(old.remove(i)),
                None => next.push(Attached {
                    key,
                    function,
                    cleanup: None,
                    owner: self.current,
                }),
            }
        }
        for a in old {
            if let Some(Some(c)) = a.cleanup {
                self.detached.push(c);
            }
        }
        if !next.is_empty() {
            self.attached.insert(element, next);
        }
    }

    /// Run the new attachments of the elements instance `i` renders, in
    /// element order (untracked; the result is the cleanup).
    fn run_attachments(&mut self, i: usize) {
        let mut elements: Vec<u64> = self
            .attached
            .iter()
            .filter(|(_, l)| l.iter().any(|a| a.owner == i && a.cleanup.is_none()))
            .map(|(e, _)| *e)
            .collect();
        elements.sort_unstable();
        for e in elements {
            let n = self.attached.get(&e).map_or(0, Vec::len);
            for k in 0..n {
                let Some(a) = self.attached.get(&e).and_then(|l| l.get(k)) else {
                    break;
                };
                if a.owner != i || a.cleanup.is_some() {
                    continue;
                }
                let f = a.function.clone();
                let outer = self.tracking.take();
                let heap_outer = js::begin_heap_reads(None);
                let r = self.call_value(&f, vec![Val::Element(js::Element(e))]);
                js::end_heap_reads(heap_outer);
                self.tracking = outer;
                let cleanup = match r {
                    Ok(Val::Closure(c)) => Some(Val::Closure(c)),
                    Ok(_) => None,
                    Err(t) => {
                        self.uncaught.push(t);
                        None
                    }
                };
                if let Some(a) = self.attached.get_mut(&e).and_then(|l| l.get_mut(k)) {
                    a.cleanup = Some(cleanup);
                }
            }
        }
    }

    /// Run the cleanups of attachments the last render removed.
    fn run_detached(&mut self) {
        for c in std::mem::take(&mut self.detached) {
            if let Err(t) = self.call_value(&c, vec![]) {
                self.uncaught.push(t);
            }
        }
    }

    /// Effect `e` of instance `i`: the component's own, then those the
    /// instance created (`effect.pre`, `effect.post`).
    fn effect_at(&self, i: usize, e: usize) -> std::borrow::Cow<'p, Effect> {
        let comp = &self.program.components[self.instances[i].component];
        match comp.effects.get(e) {
            Some(effect) => std::borrow::Cow::Borrowed(effect),
            None => {
                std::borrow::Cow::Owned(self.instances[i].dynamic[e - comp.effects.len()].0.clone())
            }
        }
    }

    /// `effect.pre(run)` / `effect.post(run)`: an effect of the instance being
    /// created, tracking what it reads. A pre effect runs at once (Svelte
    /// runs `$effect.pre` when it is created); a post effect with the
    /// instance's post effects. Cleanups run when the instance is destroyed
    /// (after its DOM is removed; pre effects parent first).
    fn create_effect(&mut self, phase: EffectPhase, run: Val) -> Res<()> {
        // In an effect root's function: an effect of the root.
        if let Some(&r) = self.root_stack.last() {
            // (A pre effect in a root is not covered: whether the framework
            // re-runs it depends on its siblings' cleanups.)
            if phase == EffectPhase::Pre {
                self.unsupported
                    .get_or_insert("a pre effect in an effect root".to_string());
                return Ok(());
            }
            self.roots[r].effects.push((phase, run));
            self.roots[r].states.push(EffectState::default());
            return Ok(());
        }
        // In an effect's run: a child of that effect.
        let parent = match (self.creating, self.running.last()) {
            (None, Some(&(i, e))) => Some((i, e)),
            _ => None,
        };
        let Some(i) = self.creating.or(parent.map(|(i, _)| i)) else {
            return Err(Throw::new(
                "RunicEffectError",
                "effects are created while a component instance is created",
            ));
        };
        let order = if phase == EffectPhase::Pre {
            TreeOrder::Pre
        } else {
            TreeOrder::Post
        };
        let meta = Effect {
            run: usize::MAX,
            phase,
            deps: EffectDeps::Tracked,
            unmount: Unmount {
                removal: Removal::After,
                order,
            },
            render: false,
            source: None,
        };
        self.instances[i].dynamic.push((meta, run));
        self.instances[i].effects.push(EffectState {
            parent: parent.map(|(_, e)| e),
            ..EffectState::default()
        });
        if phase == EffectPhase::Pre {
            let e = self.instances[i].effects.len() - 1;
            self.run_effect(i, e);
        }
        Ok(())
    }

    /// `mount`: an instance of mount site `site`'s component, created now in
    /// the body (after everything there), with its props and slot content
    /// from the calling instance; it renders after the root until unmounted.
    fn mount_site(
        &mut self,
        site: usize,
        target: &Expr,
        props: &[MountProp],
        context: Option<&Expr>,
        f: &Frame,
    ) -> Res<Val> {
        let caller = self.current;
        let owner = &self.program.components[self.instances[caller].component];
        let m: &'p MountSite = &owner.mounts[site];
        let Val::Element(target) = self.eval(target, f)? else {
            panic!("validated element")
        };
        if target != js::Element::BODY {
            let what = "mounting a component into an element other than the body (its owner's updates would interleave with the mounted content)".to_string();
            self.unsupported.get_or_insert(what.clone());
            return Err(Throw::new("RunicUnsupportedError", what));
        }
        let child = &self.program.components[m.component];
        let mut args = vec![];
        for a in props {
            let v = self.eval(&a.value, f)?;
            args.push((child.prop(&a.name).expect("validated prop"), v, None));
        }
        let context = match context {
            Some(c) => match self.eval(c, f)? {
                Val::Contexts(i) => Some(i),
                other => panic!("validated contexts, found {other:?}"),
            },
            None => None,
        };
        // Slot content renders in the calling instance, with its template
        // locals as they start (snippets keep their owner's scope).
        let values = vec![Val::Undefined; owner.template_locals.len()];
        let slots: Vec<Option<Provided<'p>>> = child
            .slots
            .iter()
            .map(|d| {
                m.slots
                    .iter()
                    .find(|s| s.name == d.name)
                    .map(|def| Provided {
                        parent: caller,
                        def,
                        values: values.clone(),
                    })
            })
            .collect();
        let id = self.create_in(m.component, &args, None, context, &slots)?;
        let handle = Rc::new(std::cell::Cell::new(Some(id)));
        self.mounted.push((Rc::clone(&handle), id));
        // Rendered (and its effects run) in the running flush's next pass,
        // or in the flush this queues.
        self.queue_flush();
        Ok(Val::Mounted(handle))
    }

    /// `mounted.unmount`: destroy a mounted instance and the instances it
    /// renders, running their cleanups as at destruction (its content leaves
    /// the document with the next render).
    fn unmount(&mut self, id: usize) {
        let order = self.tree_order();
        self.mounted.retain(|(_, i)| *i != id);
        let mut set: HashSet<usize> = HashSet::from([id]);
        for &i in &order {
            if self.instances[i].parent.is_some_and(|p| set.contains(&p)) {
                set.insert(i);
            }
        }
        let destroyed: Vec<usize> = order.iter().copied().filter(|i| set.contains(i)).collect();
        for &i in &destroyed {
            self.instances[i].alive = false;
        }
        let batched = self.program.schedule.cleanups == Cleanups::Batched;
        self.teardown(&destroyed, &order, batched);
        self.queue_flush();
    }

    /// Run the due effects of `phase` of instance `i`, each checked when
    /// its turn comes (earlier effects may have written its dependencies).
    fn run_phase_at(&mut self, i: usize, phase: EffectPhase, updated: &[bool]) {
        // (Effects created by those running are run after them, in the same
        // pass: children of the effect that created them.)
        let mut done = 0;
        loop {
            let all = self.effects_of(i, phase);
            let list: Vec<usize> = all.into_iter().filter(|&e| e >= done).collect();
            if list.is_empty() {
                break;
            }
            done = self.instances[i].effects.len();
            for e in list {
                if self.instances[i].alive && self.effect_due(i, e, updated) {
                    self.run_cleanup(i, e);
                    self.run_effect(i, e);
                }
            }
        }
    }

    /// Check effect `e` of a new instance (pre effects at creation).
    fn check_effect(&mut self, i: usize, e: usize) {
        if self.effect_due(i, e, &[]) {
            self.run_effect(i, e);
        }
    }

    /// Whether effect `e` of instance `i` runs now; records `values`.
    fn effect_due(&mut self, i: usize, e: usize, updated: &[bool]) -> bool {
        if self.instances[i].effects[e].dead {
            return false;
        }
        let effect = self.effect_at(i, e);
        let started = self.instances[i].effects[e].started;
        match &effect.deps {
            EffectDeps::Once => !started,
            EffectDeps::Always => !started || updated.get(i).copied().unwrap_or(true),
            EffectDeps::Tracked => {
                !started || self.instances[i].effects[e].rerun || {
                    let state = &self.instances[i].effects[e];
                    let reads = state.reads.clone();
                    state.heap.iter().any(js::HeapRead::changed)
                        || reads.iter().any(|r| self.read_changed(r))
                }
            }
            EffectDeps::Values { values, initial } => {
                let saved = std::mem::replace(&mut self.current, i);
                let new: Res<Vec<Val>> = values
                    .iter()
                    .map(|v| self.eval(v, &Frame::new(0)))
                    .collect();
                self.current = saved;
                // A throwing dependency is an uncaught exception; the effect does not run.
                let new = match new {
                    Ok(new) => new,
                    Err(t) => {
                        self.uncaught.push(t);
                        return false;
                    }
                };
                let state = &mut self.instances[i].effects[e];
                let changed = !started
                    || new.len() != state.values.len()
                    || new.iter().zip(&state.values).any(|(a, b)| !a.same(b));
                if !started && !initial {
                    state.values = new;
                    state.started = true;
                    return false;
                }
                changed
            }
        }
    }

    fn run_cleanup(&mut self, i: usize, e: usize) {
        // The effects its last run created, first (in creation order).
        let children: Vec<usize> = (0..self.instances[i].effects.len())
            .filter(|&c| {
                let st = &self.instances[i].effects[c];
                st.parent == Some(e) && !st.dead
            })
            .collect();
        for c in children {
            self.instances[i].effects[c].dead = true;
            self.run_cleanup(i, c);
            let st = &mut self.instances[i].effects[c];
            st.reads.clear();
            st.heap.clear();
        }
        if let Some(c) = self.instances[i].effects[e].cleanup.take() {
            self.reading_previous = self.program.schedule.cleanup_reads_previous;
            let r = self.call_value(&c, vec![]);
            self.reading_previous = false;
            if let Err(t) = r {
                self.uncaught.push(t);
            }
        }
    }

    /// Whether a tracked effect run that started at `start` (the version
    /// clock and the heap write stamp) changed a cell or a heap slot it read
    /// in that run or in its previous one: it is due again, as an effect
    /// writing what it reads is in Svelte (docs/design/REACTIVITY-ALIASING.md,
    /// R4). Derived values are not written.
    fn self_invalidated<'a>(
        &self,
        start: (u64, u64),
        mut reads: impl Iterator<Item = &'a Read_>,
        mut heap: impl Iterator<Item = &'a js::HeapRead>,
    ) -> bool {
        reads.any(|r| {
            r.derived.is_none()
                && r.field.is_none()
                && self.instances[r.instance].versions[r.cell] > start.0
        }) || heap.any(|h| h.written_since(start.1))
    }

    /// Run effect `e` of instance `i` (its cleanup already ran).
    fn run_effect(&mut self, i: usize, e: usize) {
        let effect = self.effect_at(i, e);
        if effect.render {
            self.instances[i].renders += 1;
        }
        // An effect the instance created runs its function value.
        let statics = self.program.components[self.instances[i].component]
            .effects
            .len();
        let dynamic = (e >= statics).then(|| self.instances[i].dynamic[e - statics].1.clone());
        let mut args = vec![];
        if let EffectDeps::Values { values, .. } = &effect.deps {
            let func = &self.program.functions[effect.run];
            let saved = std::mem::replace(&mut self.current, i);
            let new: Vec<Val> = values
                .iter()
                .map(|v| self.eval(v, &Frame::new(0)).unwrap_or(Val::Undefined))
                .collect();
            self.current = saved;
            if !func.params.is_empty() {
                let old = &self.instances[i].effects[e].values;
                let old: Vec<Val> = if self.instances[i].effects[e].started {
                    old.clone()
                } else {
                    vec![Val::Undefined; new.len()]
                };
                args = new.iter().cloned().chain(old).collect();
            }
            self.instances[i].effects[e].values = new;
        }
        let tracked = effect.deps == EffectDeps::Tracked;
        let outer = if tracked {
            self.tracking.replace(vec![])
        } else {
            self.tracking.take()
        };
        let heap_outer = js::begin_heap_reads(tracked.then_some(self.tracks_owned));
        let start = (self.version_clock, js::heap_stamp());
        let saved = std::mem::replace(&mut self.current, i);
        let saved_snap = self.snap.take();
        let effect_outer = std::mem::replace(&mut self.in_effect, tracked);
        self.running.push((i, e));
        let result = match &dynamic {
            Some(run) => self.call_value(run, vec![]),
            None => self.call(effect.run, vec![], args),
        };
        self.running.pop();
        self.in_effect = effect_outer;
        self.current = saved;
        self.snap = saved_snap;
        let heap = js::end_heap_reads(heap_outer);
        let reads = std::mem::replace(&mut self.tracking, outer);
        let reads = reads.unwrap_or_default();
        let again = tracked && {
            let state = &self.instances[i].effects[e];
            self.self_invalidated(
                start,
                state.reads.iter().chain(&reads),
                state.heap.iter().chain(&heap),
            )
        };
        let state = &mut self.instances[i].effects[e];
        state.started = true;
        if tracked {
            state.heap = heap;
            state.reads = reads;
            state.rerun = again;
        }
        match result {
            Ok(Val::Closure(c)) => state.cleanup = Some(Val::Closure(c)),
            Ok(_) => {}
            Err(t) => self.uncaught.push(t),
        }
    }

    /// `effect.root(f)`: a root, `f` run at once and untracked; effects it
    /// creates belong to the root. Its id.
    fn create_root(&mut self, f: &Val) -> Res<usize> {
        let r = self.roots.len();
        self.roots.push(RootScope {
            current: self.current,
            effects: vec![],
            states: vec![],
            teardown: None,
            alive: true,
        });
        self.root_stack.push(r);
        let outer = self.tracking.take();
        let result = self.call_value(f, vec![]);
        self.tracking = outer;
        self.root_stack.pop();
        if let Val::Closure(c) = result? {
            self.roots[r].teardown = Some(Val::Closure(c));
        }
        Ok(r)
    }

    /// Run effect `e` of root `r`, tracking what it reads (its cleanup already ran).
    fn run_root_effect(&mut self, r: usize, e: usize) {
        let run = self.roots[r].effects[e].1.clone();
        let outer = self.tracking.replace(vec![]);
        let heap_outer = js::begin_heap_reads(Some(self.tracks_owned));
        let start = (self.version_clock, js::heap_stamp());
        let saved = std::mem::replace(&mut self.current, self.roots[r].current);
        let saved_snap = self.snap.take();
        let effect_outer = std::mem::replace(&mut self.in_effect, true);
        let result = self.call_value(&run, vec![]);
        self.in_effect = effect_outer;
        self.current = saved;
        self.snap = saved_snap;
        let heap = js::end_heap_reads(heap_outer);
        let reads = std::mem::replace(&mut self.tracking, outer).unwrap_or_default();
        let again = {
            let state = &self.roots[r].states[e];
            self.self_invalidated(
                start,
                state.reads.iter().chain(&reads),
                state.heap.iter().chain(&heap),
            )
        };
        let state = &mut self.roots[r].states[e];
        state.started = true;
        state.heap = heap;
        state.reads = reads;
        state.rerun = again;
        match result {
            Ok(Val::Closure(c)) => state.cleanup = Some(Val::Closure(c)),
            Ok(_) => {}
            Err(t) => self.uncaught.push(t),
        }
    }

    fn run_root_cleanup(&mut self, r: usize, e: usize) {
        if let Some(c) = self.roots[r].states[e].cleanup.take() {
            // (Reading the values before the writes that re-run it, as an instance's.)
            self.reading_previous = self.program.schedule.cleanup_reads_previous;
            let result = self.call_value(&c, vec![]);
            self.reading_previous = false;
            if let Err(t) = result {
                self.uncaught.push(t);
            }
        }
    }

    /// The effects of live roots, in creation order: pre effects, then post
    /// effects, each where it never ran or what it read changed.
    fn run_roots(&mut self) {
        for r in 0..self.roots.len() {
            for phase in [EffectPhase::Pre, EffectPhase::Post] {
                for e in 0..self.roots[r].effects.len() {
                    if !self.roots[r].alive || self.roots[r].effects[e].0 != phase {
                        continue;
                    }
                    let state = &self.roots[r].states[e];
                    let due = !state.started || state.rerun || {
                        let reads = state.reads.clone();
                        state.heap.iter().any(js::HeapRead::changed)
                            || reads.iter().any(|x| self.read_changed(x))
                    };
                    if due {
                        self.run_root_cleanup(r, e);
                        self.run_root_effect(r, e);
                    }
                }
            }
        }
    }

    /// `effect.destroy-root(r)`: the cleanups of its effects in creation
    /// order, then its function's. Nothing for a root already destroyed.
    fn destroy_root(&mut self, r: usize) {
        if !self.roots.get(r).is_some_and(|x| x.alive) {
            return;
        }
        self.roots[r].alive = false;
        for e in 0..self.roots[r].effects.len() {
            self.run_root_cleanup(r, e);
        }
        if let Some(t) = self.roots[r].teardown.take() {
            if let Err(t) = self.call_value(&t, vec![]) {
                self.uncaught.push(t);
            }
        }
    }

    /// Run the cleanups of destroyed instances: those before removal, then
    /// those after, each in its effect's tree order. Under batched cleanups
    /// those of layout and post effects run in their phase's walk instead
    /// ([`Self::batched_cleanups`]).
    fn teardown(&mut self, destroyed: &[usize], order: &[usize], batched: bool) {
        if destroyed.is_empty() {
            return;
        }
        let set: HashSet<usize> = destroyed.iter().copied().collect();
        let roots: Vec<usize> = order
            .iter()
            .copied()
            .filter(|i| {
                set.contains(i) && !self.instances[*i].parent.is_some_and(|p| set.contains(&p))
            })
            .collect();
        for removal in [Removal::Before, Removal::After] {
            for &r in &roots {
                self.teardown_at(
                    r,
                    &|e: &Effect| {
                        e.unmount.removal == removal && !(batched && e.phase != EffectPhase::Pre)
                    },
                    &set,
                    order,
                );
            }
        }
    }

    /// The batched cleanups of `phase` in the subtree of live instance `i`,
    /// in React's commit walk (react-dom `recursivelyTraverseMutationEffects`
    /// for layout, `recursivelyTraversePassiveUnmountEffects` for passive
    /// effects): children first, and at each instance the instances
    /// destroyed under it (each subtree in its effects' `unmount.order`)
    /// before its live children, then its own due cleanups.
    fn batched_cleanups(
        &mut self,
        i: usize,
        phase: EffectPhase,
        due: &[(usize, usize)],
        after: &[usize],
        destroyed: &HashSet<usize>,
        before: &[usize],
    ) {
        let gone: Vec<usize> = before
            .iter()
            .copied()
            .filter(|d| destroyed.contains(d) && self.instances[*d].parent == Some(i))
            .collect();
        for d in gone {
            self.teardown_at(d, &|e: &Effect| e.phase == phase, destroyed, before);
        }
        let live: Vec<usize> = after
            .iter()
            .copied()
            .filter(|c| self.instances[*c].parent == Some(i))
            .collect();
        for c in live {
            self.batched_cleanups(c, phase, due, after, destroyed, before);
        }
        for &(j, e) in due {
            if j == i {
                self.run_cleanup(i, e);
            }
        }
    }

    /// Cleanups of the effects selected by `which` in the destroyed subtree
    /// of `i`, each at its `unmount.order` position.
    fn teardown_at(
        &mut self,
        i: usize,
        which: &dyn Fn(&Effect) -> bool,
        set: &HashSet<usize>,
        order: &[usize],
    ) {
        let at = |o: TreeOrder| -> Vec<usize> {
            (0..self.instances[i].effects.len())
                .filter(|&e| {
                    let effect = self.effect_at(i, e);
                    which(&effect) && effect.unmount.order == o
                })
                .collect()
        };
        let (pre, post) = (at(TreeOrder::Pre), at(TreeOrder::Post));
        for e in pre {
            self.run_cleanup(i, e);
        }
        let children: Vec<usize> = order
            .iter()
            .copied()
            .filter(|c| set.contains(c) && self.instances[*c].parent == Some(i))
            .collect();
        for c in children {
            self.teardown_at(c, which, set, order);
        }
        for e in post {
            self.run_cleanup(i, e);
        }
    }

    /// The initial mount: render, then the mount flush at the program's timing.
    fn mount(&mut self) -> Result<()> {
        self.render()?;
        for i in &mut self.instances {
            i.snapshot = Rc::new(i.cells.clone());
        }
        match self.program.schedule.mount {
            MountTiming::Sync => self.flush(),
            _ if self.flush_pending => {}
            MountTiming::Microtask => {
                self.flush_pending = true;
                self.microtasks.push_back(Micro::Flush);
            }
            MountTiming::Task => {
                self.flush_pending = true;
                self.default_tasks.push_back(Micro::Flush);
            }
        }
        self.checkpoint();
        while let Some(job) = self.default_tasks.pop_front() {
            self.run_micro(job);
            self.checkpoint();
        }
        self.late_rejection_handlers();
        match std::mem::take(&mut self.uncaught).into_iter().next() {
            Some(t) => Err(throw_diag(t)),
            None => Ok(()),
        }
    }

    /// Run handler `h` of instance `instance` with listener arguments (in
    /// the running task).
    fn run(
        &mut self,
        instance: usize,
        h: usize,
        args: Vec<Val>,
        event: Option<js::Event>,
    ) -> Res<()> {
        let component = self.instances[instance].component;
        let handler = &self.program.components[component].handlers[h];
        // A handler may run nested in another (focus events from focus()).
        let outer = (
            std::mem::replace(&mut self.payload, event.as_ref().and_then(payload_of)),
            std::mem::replace(&mut self.event, event),
        );
        let frame = Frame::new(handler.params.len() + handler.locals.len());
        for (i, a) in args.into_iter().enumerate() {
            frame.set(i, a);
        }
        let saved = std::mem::replace(&mut self.current, instance);
        let saved_snap = self.snap.take();
        let r = self.exec_block(&handler.body, &frame);
        self.current = saved;
        self.snap = saved_snap;
        (self.payload, self.event) = outer;
        r.map(|_| ())
    }

    // Time ------------------------------------------------------------------------

    /// Advance the virtual clock by `ms`, running every timer and animation
    /// frame that becomes due, in order (Playwright's fake clock semantics).
    pub fn advance(&mut self, ms: f64) -> Result<()> {
        let to = (self.now + ms.max(0.0)).ceil();
        let mut fired = 0u32;
        loop {
            let Some(i) = self.first_timer(to) else { break };
            fired += 1;
            if fired > 100_000 {
                return Err(Diagnostic::new(
                    "E_TIMERS",
                    "Timers keep firing without time advancing",
                    None,
                ));
            }
            let t = &mut self.timers[i];
            self.now = self.now.max(t.call_at);
            let (callback, kind) = (t.callback.clone(), t.kind);
            match kind {
                TimerKind::Interval => t.call_at += t.delay,
                _ => {
                    self.timers.remove(i);
                }
            }
            let args = match kind {
                TimerKind::Frame => vec![Val::Num(self.now)],
                _ => vec![],
            };
            self.during_tick = true;
            let r = self.task(None, false, |m| m.call_value(&callback, args).map(|_| ()));
            self.during_tick = false;
            r?;
        }
        self.now = self.now.max(to);
        // The host's work queued by the timers runs after them (as the
        // browser's after Playwright's fake clock ran them).
        let mut run = Run::default();
        self.host_tasks(&mut run);
        self.focus_fixup(&mut run);
        run.error.map_or(Ok(()), Err)
    }

    /// The rendering step's focus fixup: a focused control that became
    /// disabled is blurred, with `blur` and `focusout` as events of their
    /// own. (Elements hidden by CSS are not modelled here: the interpreter
    /// has no style.)
    fn focus_fixup(&mut self, s: &mut Run) {
        let Some(f) = self.focused else { return };
        let tree = match self.render() {
            Ok(t) => t,
            Err(d) => {
                s.error.get_or_insert(d);
                return;
            }
        };
        let disabled = chain_nodes(&tree, f).is_some_and(|nodes| {
            matches!(nodes.last(), Some(VNode::Element { tag, attrs, .. })
                if matches!(tag.as_str(), "button" | "input" | "textarea" | "select")
                    && attrs.contains_key("disabled"))
        });
        if disabled {
            if let Err(d) = self.move_focus(None, s) {
                s.error.get_or_insert(d);
            }
        }
    }

    /// Index of the first timer due at or before `to`.
    fn first_timer(&self, to: f64) -> Option<usize> {
        self.timers
            .iter()
            .enumerate()
            .filter(|(_, t)| t.call_at <= to)
            .min_by(|(_, a), (_, b)| {
                a.call_at
                    .total_cmp(&b.call_at)
                    .then(a.created_at.total_cmp(&b.created_at))
                    .then(a.id.cmp(&b.id))
            })
            .map(|(i, _)| i)
    }

    fn add_timer(&mut self, kind: TimerKind, callback: Val, delay: f64) -> Val {
        let mut delay = if delay.is_finite() { delay } else { 0.0 };
        if delay > 2_147_483_647.0 {
            delay = 1.0;
        }
        let delay = delay.max(0.0);
        let id = self.next_timer;
        self.next_timer += 1;
        let after = if delay != 0.0 {
            delay
        } else if self.during_tick {
            1.0
        } else {
            0.0
        };
        self.timers.push(Timer {
            id,
            kind,
            callback,
            delay,
            call_at: self.now + after,
            created_at: self.now,
        });
        Val::Num(id as f64)
    }

    /// Perform a harness action on `target` with Chromium's event sequences
    /// (docs/design/M5-PLATFORM.md): `click`, `dblclick`, `contextmenu`,
    /// `hover`, `input` (`data`: the new value), `keydown` (`data`: a key
    /// specification; the key is pressed and released) or `wheel` (`data`:
    /// `"dx,dy"`). Returns whether any listener ran. The interpreter has no
    /// layout: pointer events target the element itself rather than the
    /// element hit at its centre, and carry zero coordinates. The host's
    /// work queued by the action (clipboard replies, traversals) runs after it.
    pub fn fire(&mut self, target: Target<'_>, action: &str, data: Option<&str>) -> Result<bool> {
        let result = self.fire_action(target, action, data);
        let mut run = Run::default();
        self.host_tasks(&mut run);
        match (result, run.error) {
            (Err(d), _) | (Ok(_), Some(d)) => Err(d),
            (Ok(ran), None) => Ok(ran || run.ran),
        }
    }

    fn fire_action(
        &mut self,
        target: Target<'_>,
        action: &str,
        data: Option<&str>,
    ) -> Result<bool> {
        let tree = self.render()?;
        let Some(path) = locate(&tree, &target) else {
            return match target {
                Target::Id(id) => Err(Diagnostic::new(
                    "E_TARGET",
                    format!("No element #{id} is rendered"),
                    None,
                )),
                Target::ElementPath { .. } => Err(Diagnostic::new(
                    "E_TARGET_PATH",
                    "resolved pointer target differs from the interpreter's live tree",
                    None,
                )),
                Target::Nth(..) | Target::Path(_) => Ok(false),
            };
        };
        let Some(&&VNode::Element { id, .. }) = path_nodes(&tree, &path).last() else {
            unreachable!("paths end at elements")
        };
        let mut run = Run::default();
        let s = &mut run;
        match action {
            "click" => self.press(id, 0.0, 1, s)?,
            "dblclick" => {
                self.press(id, 0.0, 1, s)?;
                self.press(id, 0.0, 2, s)?;
            }
            "contextmenu" => self.press(id, 2.0, 1, s)?,
            "hover" => self.pointer_move(id, s)?,
            "wheel" => {
                let (dx, dy) = data
                    .and_then(|d| d.split_once(','))
                    .and_then(|(x, y)| Some((x.trim().parse().ok()?, y.trim().parse().ok()?)))
                    .unwrap_or((0.0, 0.0));
                self.pointer_move(id, s)?;
                let data = js::EventData {
                    delta_x: dx,
                    delta_y: dy,
                    ..Default::default()
                };
                self.dispatch(id, EventKind::Wheel, data, None, s)?;
            }
            "choose" => {
                // Picking an option: it is shown, then input and change (a
                // value no option has cannot be picked).
                let tree = self.render()?;
                let exists = select_options(&tree, id)
                    .is_some_and(|(o, _)| o.iter().any(|o| Some(o.0.as_str()) == data && o.1));
                if exists && !self.inside_disabled(id)? {
                    let v = data.unwrap_or_default().to_owned();
                    self.live_values.insert(id, v.clone());
                    let data = js::EventData {
                        value: JsString::from(v.as_str()),
                        ..Default::default()
                    };
                    self.dispatch(id, EventKind::Input, data.clone(), None, s)?;
                    self.dispatch(id, EventKind::Change, data, None, s)?;
                }
            }
            "input" => {
                let tree = self.render()?;
                let locked = chain_nodes(&tree, id).and_then(|n| n.last().copied()).is_some_and(
                    |n| matches!(n, VNode::Element { attrs, .. } if attrs.contains_key("disabled") || attrs.contains_key("readonly")),
                );
                if !locked {
                    self.live_values
                        .insert(id, data.unwrap_or_default().to_owned());
                    let data = js::EventData {
                        value: JsString::from(data.unwrap_or_default()),
                        ..Default::default()
                    };
                    self.dispatch(id, EventKind::Input, data, None, s)?;
                }
            }
            "keydown" => self.key(id, data.unwrap_or_default(), s)?,
            other => {
                return Err(Diagnostic::new(
                    "E_INPUT",
                    format!("unknown action {other}"),
                    None,
                ));
            }
        }
        self.focus_fixup(&mut run);
        match run.error {
            Some(d) => Err(d),
            None => Ok(run.ran),
        }
    }

    /// The viewport or the user preferences changed (probe actions `resize`
    /// and `emulate`). The rendering step dispatches the window's `resize`
    /// event when the size changed, then a `change` event at each media
    /// query list whose state changed since it was created or last
    /// notified, oldest first.
    pub fn environ(&mut self, env: runic_css::MediaEnv) -> Result<bool> {
        let resized = env.width != self.media.width || env.height != self.media.height;
        self.media = env;
        let mut run = Run::default();
        let s = &mut run;
        if resized {
            let event = js::Event::new(js::EventData {
                kind: "resize".into(),
                target: js::Element::WINDOW,
                ..Default::default()
            });
            self.dispatch_capture(EventKind::Resize, &event, false, s);
            self.dispatch_globals(EventKind::Resize, &event, s);
            event.finish();
            // Then the visual viewport's (it resizes with the window).
            let event = js::Event::new(js::EventData {
                kind: "resize".into(),
                target: js::Element::VISUAL_VIEWPORT,
                ..Default::default()
            });
            let listeners: Vec<Val> = self
                .viewport_listeners
                .iter()
                .filter(|g| g.0 == EventKind::Resize)
                .map(|g| g.1.clone())
                .collect();
            for f in listeners {
                let live = self
                    .viewport_listeners
                    .iter()
                    .any(|g| g.0 == EventKind::Resize && g.1.same(&f));
                if !live || !event.enter(js::Element::VISUAL_VIEWPORT) {
                    continue;
                }
                s.ran = true;
                let arg = Val::Event(event.clone());
                let result = self.task(None, true, |m| m.call_value(&f, vec![arg]).map(|_| ()));
                if let Err(d) = result {
                    s.error.get_or_insert(d);
                }
            }
            event.finish();
        }
        let lists: Vec<js::MediaQueryList> =
            self.media_lists.iter().map(|(l, _)| l.clone()).collect();
        for list in lists {
            let matches = runic_css::media_matches(list.query(), &self.media).unwrap_or(false);
            if !list.update(matches) {
                continue;
            }
            let event = js::Event::new(js::EventData {
                kind: "change".into(),
                matches,
                media: true,
                ..Default::default()
            });
            let listeners = self
                .media_lists
                .iter()
                .find(|(l, _)| *l == list)
                .map(|(_, fs)| fs.clone())
                .unwrap_or_default();
            for f in listeners {
                let live = self
                    .media_lists
                    .iter()
                    .any(|(l, fs)| *l == list && fs.iter().any(|g| g.same(&f)));
                if !live {
                    continue;
                }
                s.ran = true;
                let arg = Val::Event(event.clone());
                let result = self.task(None, true, |m| m.call_value(&f, vec![arg]).map(|_| ()));
                if let Err(d) = result {
                    s.error.get_or_insert(d);
                }
            }
            event.finish();
        }
        self.focus_fixup(&mut run);
        match run.error {
            Some(d) => Err(d),
            None => Ok(run.ran),
        }
    }

    /// The media environment (the probe's viewport and preferences).
    pub fn media(&self) -> runic_css::MediaEnv {
        self.media
    }

    /// Whether `target` is (inside) a disabled button or input.
    fn inside_disabled(&mut self, target: u64) -> Result<bool> {
        let tree = self.render()?;
        Ok(chain_nodes(&tree, target).is_some_and(|nodes| {
            nodes.iter().any(|n| matches!(n, VNode::Element { tag, attrs, .. } if matches!(tag.as_str(), "button" | "input" | "textarea" | "select") && attrs.contains_key("disabled")))
                || nodes.iter().filter_map(|n| element_id(n)).any(|id| form_control(&tree, id).is_some_and(|c| matches!(c.tag.as_str(), "button" | "input" | "select" | "textarea") && c.disabled))
        }))
    }

    /// Move the pointer onto `target`: Chromium's boundary events where the
    /// hovered elements change (pointer events, then mouse events; leaving
    /// innermost first, entering outermost first; none for removed
    /// elements), then `pointermove` and `mousemove`.
    fn pointer_move(&mut self, target: u64, s: &mut Run) -> Result<()> {
        let tree = self.render()?;
        let Some(nodes) = chain_nodes(&tree, target) else {
            return Ok(());
        };
        let new: Vec<u64> = nodes.iter().filter_map(|n| element_id(n)).collect();
        let old = std::mem::replace(&mut self.hovered, new.clone());
        let common = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
        let left: Vec<u64> = old[common..]
            .iter()
            .rev()
            .copied()
            .filter(|&id| chain_nodes(&tree, id).is_some())
            .collect();
        let entered = &new[common..];
        let data = |related: Option<u64>, button: f64| js::EventData {
            related: related.map(js::Element),
            button,
            ..Default::default()
        };
        // The targets change: `out` at the old one (if still in the tree)
        // and `over` at the new one, around the leave and enter events (UI
        // Events order: pointer events, then mouse events).
        let moved = old.last() != new.last();
        let out_at = old
            .last()
            .copied()
            .filter(|&id| moved && chain_nodes(&tree, id).is_some());
        let over_at = new.last().copied().filter(|_| moved);
        for (out, leave, over, enter) in [
            (
                EventKind::Pointerout,
                EventKind::Pointerleave,
                EventKind::Pointerover,
                EventKind::Pointerenter,
            ),
            (
                EventKind::Mouseout,
                EventKind::Mouseleave,
                EventKind::Mouseover,
                EventKind::Mouseenter,
            ),
        ] {
            let button = if leave == EventKind::Pointerleave {
                -1.
            } else {
                0.
            };
            if let Some(id) = out_at {
                self.dispatch(id, out, data(new.last().copied(), button), None, s)?;
            }
            for &id in &left {
                self.dispatch(id, leave, data(new.last().copied(), button), None, s)?;
            }
            if let Some(id) = over_at {
                self.dispatch(id, over, data(old.last().copied(), button), None, s)?;
            }
            for &id in entered {
                self.dispatch(id, enter, data(old.last().copied(), button), None, s)?;
            }
        }
        self.dispatch(target, EventKind::Pointermove, data(None, -1.), None, s)?;
        self.dispatch(target, EventKind::Mousemove, Default::default(), None, s)?;
        Ok(())
    }

    /// A button press on `target` as Playwright clicks: the move (before a
    /// first click), down, up, then the click (main button; `count`: the
    /// click count) or, after mousedown, the context menu (secondary button,
    /// as on Linux). Disabled controls get the pointer events only; a
    /// cancelled `pointerdown` suppresses the mouse events up to `mouseup`
    /// and mousedown's default actions (focus stays, Chromium 153).
    fn press(&mut self, target: u64, button: f64, count: u32, s: &mut Run) -> Result<()> {
        if count == 1 {
            self.pointer_move(target, s)?;
        }
        // A press closes an open select popup, committing its highlight.
        let closed_popup = self.popup.is_some();
        self.close_popup(false, s)?;
        // `detail`: the click count of main button presses (one press
        // of another button counts one).
        let detail = if button == 0.0 { count as f64 } else { 1.0 };
        let pressed = js::EventData {
            button,
            buttons: if button == 2.0 { 2.0 } else { 1.0 },
            detail,
            ..Default::default()
        };
        let released = js::EventData {
            button,
            detail,
            ..Default::default()
        };
        let disabled = self.inside_disabled(target)?;
        let down = self.dispatch(target, EventKind::Pointerdown, pressed.clone(), None, s)?;
        let compat = !disabled && !down.is_some_and(|e| e.default_prevented());
        let mousedown = if compat {
            self.dispatch(target, EventKind::Mousedown, pressed.clone(), None, s)?
        } else {
            None
        };
        // Focus moves on mousedown unless it or pointerdown was cancelled: to
        // the focusable element pressed, nowhere for anything else (disabled
        // controls too).
        let cancelled_down = !disabled && !compat;
        if !cancelled_down && !mousedown.is_some_and(|e| e.default_prevented()) {
            let tree = self.render()?;
            let next = chain_nodes(&tree, target).and_then(|n| focus_target(&n));
            self.move_focus(next, s)?;
            // A press on a closed select opens its popup.
            if button == 0.0 && !closed_popup && !disabled {
                let tree = self.render()?;
                let select = chain_nodes(&tree, target).and_then(|nodes| {
                    nodes.iter().rev().find_map(|n| match n {
                        VNode::Element { tag, id, .. } if tag == "select" => Some(*id),
                        _ => None,
                    })
                });
                if let Some(select) = select {
                    let shown = select_options(&tree, select)
                        .and_then(|(o, v)| o.iter().position(|x| Some(&x.0) == v.as_ref()));
                    self.popup = Some((select, shown));
                }
            }
        }
        if button == 2.0 && !disabled {
            self.dispatch(target, EventKind::Contextmenu, pressed, None, s)?;
        }
        self.dispatch(target, EventKind::Pointerup, released.clone(), None, s)?;
        if compat {
            self.dispatch(target, EventKind::Mouseup, released, None, s)?;
        }
        if button == 0.0 && !self.inside_disabled(target)? {
            self.click_counted(target, detail, s)?;
            if count == 2 {
                let data = js::EventData {
                    detail: 2.0,
                    ..Default::default()
                };
                self.dispatch(target, EventKind::Dblclick, data, None, s)?;
            }
        }
        Ok(())
    }

    /// The `click` event on `target` (a pointer click or a keyboard
    /// activation). A checkbox toggles first; its `change` follows unless the
    /// click was cancelled (the browser then reverts the toggle), or runs in
    /// the click's dispatch where the framework delivers it with the click.
    fn click(&mut self, target: u64, s: &mut Run) -> Result<()> {
        self.click_counted(target, 0.0, s)
    }

    /// The `click` event of a pointer click (`detail`: its click count;
    /// keyboard and simulated clicks have 0).
    fn click_counted(&mut self, target: u64, detail: f64, s: &mut Run) -> Result<()> {
        let tree = self.render()?;
        let Some(nodes) = chain_nodes(&tree, target) else {
            return Ok(());
        };
        // Click activation belongs to the original control even if a callback
        // moves its descendant target beneath a different control.
        let clicked_control = form_clicked_control(&tree, target);
        // A checkbox flips; a radio button is checked and its group's other
        // one unchecked (a checked radio button only gets the click).
        let (toggled, previous) = match nodes.last() {
            Some(VNode::Element {
                checked: Some(c),
                attrs,
                ..
            }) if attrs.get("type").is_some_and(|t| t == "radio") => {
                if *c {
                    (None, vec![])
                } else {
                    let others: Vec<u64> = radio_group(&tree, target)
                        .into_iter()
                        .filter(|&(r, on)| r != target && on)
                        .map(|(r, _)| r)
                        .collect();
                    (Some(true), others)
                }
            }
            Some(VNode::Element {
                checked: Some(c), ..
            }) => (Some(!c), vec![]),
            _ => (None, vec![]),
        };
        let change = toggled.map(|checked| js::EventData {
            checked,
            ..Default::default()
        });
        let with_click = self.program.schedule.change_with_click;
        let data = js::EventData {
            checked: toggled.unwrap_or_default(),
            detail,
            ..Default::default()
        };
        let with = change
            .clone()
            .filter(|_| with_click)
            .map(|d| (EventKind::Change, d));
        let tasks = self.tasks_run;
        let click = self.dispatch(target, EventKind::Click, data, with, s)?;
        let cancelled = click.as_ref().is_some_and(|e| e.default_prevented());
        // The toggle stays unless the click was cancelled.
        if let (Some(on), false) = (toggled, cancelled) {
            self.live_checked.insert(target, on);
            for r in previous {
                self.live_checked.insert(r, false);
            }
            // The toggle preceded the listeners, after which controlled
            // values are restored (React).
            if self.program.schedule.controlled_restore && self.tasks_run != tasks {
                self.restore_due = true;
                self.render()?;
            }
        }
        if let Some(d) = change.filter(|_| !with_click) {
            if !cancelled {
                self.dispatch(target, EventKind::Change, d, None, s)?;
            }
        }
        // A link's activation follows it; label activation is a simulated
        // click on a labelled checkbox or button.
        if click.is_some() && !cancelled {
            let tree = self.render()?;
            if let Some((control, snapshot)) = clicked_control
                .and_then(|control| form_control(&tree, control).map(|c| (control, c)))
            {
                if snapshot.disabled {
                    return Ok(());
                }
                match snapshot.activation() {
                    js::forms::Activation::Submit => {
                        if let Some(form) = form_owner(&tree, control) {
                            self.submit_form(form, Some(control), s)?;
                            return Ok(());
                        }
                    }
                    js::forms::Activation::Reset => {
                        if form_owner(&tree, control).is_some() {
                            return Err(throw_diag(form_unsupported("form reset")));
                        }
                    }
                    js::forms::Activation::UnsupportedCommand => {
                        return Err(throw_diag(form_unsupported(
                            "Auto button command activation",
                        )));
                    }
                    js::forms::Activation::None => {}
                }
            }
            if let Some(href) = link_of(&tree, target) {
                self.follow_link(&tree, &href, s)?;
            } else if let Some(control) = labelled_control(&tree, target) {
                let clickable = form_control(&tree, control).is_some_and(|c| {
                    c.tag == "button"
                        || (c.tag == "input"
                            && matches!(
                                c.input_type(),
                                "checkbox" | "radio" | "submit" | "image" | "reset" | "button"
                            ))
                });
                if !self.inside_disabled(control)? {
                    if clickable {
                        self.click(control, s)?;
                    }
                    self.move_focus(Some(control), s)?;
                }
            }
        }
        Ok(())
    }

    /// Start a live submission without guessing control validity from values.
    fn begin_submission(&mut self, form: u64, submitter: Option<u64>) -> Res<bool> {
        if !is_form(&self.last_tree, form) || self.submitting_forms.contains(&form) {
            return Ok(false);
        }
        self.submitting_forms.insert(form);
        let nested = chain_nodes(&self.last_tree, form).is_some_and(|nodes| {
            nodes[..nodes.len() - 1]
                .iter()
                .any(|n| matches!(n, VNode::Element { tag, .. } if tag == "form"))
                || match nodes.last() {
                    Some(VNode::Element { children, .. }) => form_tree_elements(children)
                        .iter()
                        .any(|n| matches!(n, VNode::Element { tag, .. } if tag == "form")),
                    _ => false,
                }
        });
        if nested {
            self.submitting_forms.remove(&form);
            return Err(form_unsupported(
                "submission of nested live forms (parser-specific ownership)",
            ));
        }
        let controls = form_controls(&self.last_tree, form);
        let bypass = form_has_attr(&self.last_tree, form, "novalidate")
            || submitter.is_some_and(|s| form_has_attr(&self.last_tree, s, "formnovalidate"));
        if !bypass {
            if let Some(gap) = js::forms::validation_gap(&controls) {
                self.submitting_forms.remove(&form);
                return Err(form_unsupported(&gap));
            }
        }
        Ok(true)
    }

    fn finish_submission(&self, form: u64, event: Option<&js::Event>) -> Res<()> {
        if event.is_none_or(|e| e.default_prevented()) || !is_form(&self.last_tree, form) {
            return Ok(());
        }
        Err(form_unsupported(
            "uncanceled form submission (navigation, form data or dialog default)",
        ))
    }

    /// Physical activation owns ordinary event checkpoints, unlike requestSubmit.
    fn submit_form(&mut self, form: u64, submitter: Option<u64>, s: &mut Run) -> Result<()> {
        if !self.begin_submission(form, submitter).map_err(throw_diag)? {
            return Ok(());
        }
        let result = self.dispatch_submit_path(form, s);
        self.submitting_forms.remove(&form);
        let event = result?;
        self.render()?;
        self.finish_submission(form, event.as_ref())
            .map_err(throw_diag)
    }

    /// No argument means the form itself, never a default-button click.
    fn request_submit(&mut self, form: u64) -> Res<()> {
        if !is_form(&self.last_tree, form) {
            return if self.detached_shadowed_forms.contains(&form) {
                Err(form_unsupported(
                    "requestSubmit on a disconnected form with named-property shadowing",
                ))
            } else if self.known_forms.contains(&form) {
                self.host
                    .console
                    .push(("warn", js::forms::DISCONNECTED_SUBMISSION_WARNING.into()));
                Ok(())
            } else {
                Err(form_unsupported("requestSubmit on a non-form receiver"))
            };
        }
        if form_request_submit_shadowed(&self.last_tree, form) {
            return Err(form_unsupported(
                "requestSubmit shadowed by an owned control",
            ));
        }
        if !self.begin_submission(form, None)? {
            return Ok(());
        }
        let outer_dispatching = std::mem::replace(&mut self.dispatching, true);
        let outer_in_event = std::mem::replace(&mut self.in_event, true);
        let event = self.dispatch_nested(form, EventKind::Submit, js::EventData::default(), true);
        self.dispatching = outer_dispatching;
        self.in_event = outer_in_event;
        self.submitting_forms.remove(&form);
        self.finish_submission(form, event.as_ref())
    }

    /// Follow a link after its click: a fragment navigation (`popstate` at
    /// once, `hashchange` as a task when the fragment changed). Scrolling to
    /// and focusing an element the fragment names need the layout.
    fn follow_link(&mut self, tree: &[VNode], href: &str, s: &mut Run) -> Result<()> {
        if let Some(name) = href.strip_prefix('#') {
            let decoded = percent_decode(name);
            if decoded.is_empty()
                || decoded.eq_ignore_ascii_case("top")
                || fragment_target(tree, &decoded)
            {
                return Err(Diagnostic::new(
                    "E_LAYOUT",
                    format!(
                        "following the link {href:?} scrolls the document, which needs the native layout"
                    ),
                    None,
                ));
            }
        }
        let changed = self
            .host
            .session
            .follow_fragment(&JsString::from(href))
            .map_err(throw_diag)?;
        self.window_event(EventKind::Popstate, s);
        if changed {
            self.host.tasks.push_back(HostTask::HashChange);
        }
        Ok(())
    }

    /// A key pressed and released on `target` (modifiers pressed before and
    /// released after it), with the activation behaviour of buttons (Enter
    /// on keydown, Space after keyup) and checkboxes (Space after keyup)
    /// unless a listener cancelled it.
    fn key(&mut self, target: u64, spec: &str, s: &mut Run) -> Result<()> {
        let Some(k) = js::parse_key_spec(spec) else {
            return Err(Diagnostic::new(
                "E_INPUT",
                format!("unsupported key {spec}"),
                None,
            ));
        };
        if self.inside_disabled(target)? {
            return Ok(());
        }
        // The key goes to the target, focused first (as the probe does).
        self.move_focus(Some(target), s)?;
        // An open select popup takes the key downs (Tab closes it, then acts).
        if self.popup.is_some() && k.key == "Tab" {
            self.close_popup(false, s)?;
        }
        let popup_keys = self.popup.is_some();
        let mods = k.modifiers.clone();
        let mut held = js::KeySpec::default();
        let data = |key: &str, code: &str, held: &js::KeySpec| js::EventData {
            key: JsString::from(key),
            code: JsString::from(code),
            ctrl: held.ctrl,
            shift: held.shift,
            alt: held.alt,
            meta: held.meta,
            ..Default::default()
        };
        let hold = |held: &mut js::KeySpec, m: &str, on: bool| match m {
            "Shift" => held.shift = on,
            "Control" => held.ctrl = on,
            "Alt" => held.alt = on,
            _ => held.meta = on,
        };
        if popup_keys {
            for (m, _) in &mods {
                hold(&mut held, m, true);
            }
            match k.key.as_str() {
                "Enter" => self.close_popup(true, s)?,
                "Escape" => self.close_popup(false, s)?,
                key => {
                    if let Some((select, from)) = self.popup {
                        let tree = self.render()?;
                        if let Some(i) = popup_key(&tree, select, from, key) {
                            self.popup = Some((select, Some(i)));
                        }
                    }
                }
            }
            self.dispatch(
                target,
                EventKind::Keyup,
                data(&k.key, &k.code, &held),
                None,
                s,
            )?;
            for (m, code) in mods.iter().rev() {
                hold(&mut held, m, false);
                self.dispatch(target, EventKind::Keyup, data(m, code, &held), None, s)?;
            }
            return Ok(());
        }
        for (m, code) in &mods {
            hold(&mut held, m, true);
            self.dispatch(target, EventKind::Keydown, data(m, code, &held), None, s)?;
        }
        let down = self.dispatch(
            target,
            EventKind::Keydown,
            data(&k.key, &k.code, &held),
            None,
            s,
        )?;
        let cancelled = down.is_some_and(|e| e.default_prevented());
        let tree = self.render()?;
        // Arrows move to the next (previous) enabled radio button of the
        // group, wrapping, and check it.
        let radio = chain_nodes(&tree, target).and_then(|n| n.last().copied()).is_some_and(
            |n| matches!(n, VNode::Element { tag, attrs, .. } if tag == "input" && attrs.get("type").is_some_and(|t| t == "radio")),
        );
        if !cancelled
            && radio
            && matches!(
                k.key.as_str(),
                "ArrowDown" | "ArrowRight" | "ArrowUp" | "ArrowLeft"
            )
        {
            let group: Vec<u64> = radio_group_enabled(&tree, target);
            if let Some(i) = group.iter().position(|&r| r == target) {
                let n = group.len();
                let forward = matches!(k.key.as_str(), "ArrowDown" | "ArrowRight");
                let next = if forward {
                    group[(i + 1) % n]
                } else {
                    group[(i + n - 1) % n]
                };
                if next != target {
                    self.move_focus(Some(next), s)?;
                    self.click(next, s)?;
                }
            }
        }
        // A focused closed select changes its option with the keyboard.
        if !cancelled {
            if let Some(value) = select_key_target(&tree, target, &k.key) {
                self.live_values.insert(target, value.clone());
                let data = js::EventData {
                    value: JsString::from(value.as_str()),
                    ..Default::default()
                };
                self.dispatch(target, EventKind::Input, data.clone(), None, s)?;
                self.dispatch(target, EventKind::Change, data, None, s)?;
            }
        }
        let tree = self.render()?;
        let (button, checkbox, link) =
            match chain_nodes(&tree, target).and_then(|n| n.last().copied()) {
                Some(VNode::Element {
                    tag,
                    checked,
                    attrs,
                    ..
                }) => (
                    tag == "button"
                        || form_control(&tree, target).is_some_and(|c| {
                            c.tag == "input"
                                && matches!(c.input_type(), "submit" | "image" | "reset" | "button")
                        }),
                    tag == "input" && checked.is_some(),
                    tag == "a" && attrs.contains_key("href"),
                ),
                _ => (false, false, false),
            };
        // Enter activates a button or a link (a simulated click).
        if !cancelled && (button || link) && k.key == "Enter" {
            self.click(target, s)?;
        } else if !cancelled && k.key == "Enter" {
            if let Some(control) = form_control(&tree, target) {
                if let Some(form) = form_owner(&tree, target) {
                    if control.enter_trigger() {
                        match js::forms::implicit_submission(&form_controls(&tree, form)) {
                            js::forms::Implicit::Nothing => {}
                            js::forms::Implicit::Click(button) => self.click(button, s)?,
                            js::forms::Implicit::Submit => self.submit_form(form, None, s)?,
                        }
                    } else if control.blocks_implicit() {
                        return Err(throw_diag(form_unsupported(
                            "implicit submission from this input type",
                        )));
                    }
                }
            }
        }
        let up = self.dispatch(
            target,
            EventKind::Keyup,
            data(&k.key, &k.code, &held),
            None,
            s,
        )?;
        if !cancelled
            && !up.is_some_and(|e| e.default_prevented())
            && (button || checkbox)
            && k.key == " "
        {
            self.click(target, s)?;
        }
        for (m, code) in mods.iter().rev() {
            hold(&mut held, m, false);
            self.dispatch(target, EventKind::Keyup, data(m, code, &held), None, s)?;
        }
        Ok(())
    }

    /// Close the select popup: the highlighted option becomes the select's
    /// (`input`, `change` when it changes), then for Enter a `click`.
    fn close_popup(&mut self, click: bool, s: &mut Run) -> Result<()> {
        let Some((select, highlighted)) = self.popup.take() else {
            return Ok(());
        };
        let tree = self.render()?;
        let Some((options, value)) = select_options(&tree, select) else {
            return Ok(());
        };
        if let Some(i) = highlighted {
            if value.as_ref() != options.get(i).map(|o| &o.0) {
                let v = options[i].0.clone();
                self.live_values.insert(select, v.clone());
                let data = js::EventData {
                    value: JsString::from(v.as_str()),
                    ..Default::default()
                };
                self.dispatch(select, EventKind::Input, data.clone(), None, s)?;
                self.dispatch(select, EventKind::Change, data, None, s)?;
            }
        }
        if click {
            self.click(select, s)?;
        }
        Ok(())
    }

    /// Move focus: the focus events in Chromium's order (`blur`, `focusout`,
    /// `focus`, `focusin`, naming the other element as `relatedTarget`).
    fn focus_events(&mut self, next: Option<u64>) -> Vec<(u64, EventKind, js::EventData)> {
        let old = self.focused;
        if old == next {
            return vec![];
        }
        self.focused = next;
        let related = |n: Option<u64>| js::EventData {
            related: n.map(js::Element),
            ..Default::default()
        };
        let mut events = vec![];
        if let Some(o) = old {
            events.push((o, EventKind::Blur, related(next)));
            events.push((o, EventKind::Focusout, related(next)));
        }
        if let Some(n) = next {
            events.push((n, EventKind::Focus, related(old)));
            events.push((n, EventKind::Focusin, related(old)));
        }
        events
    }

    /// A user action moves focus: each focus event is dispatched on its own.
    fn move_focus(&mut self, next: Option<u64>, s: &mut Run) -> Result<()> {
        for (target, kind, data) in self.focus_events(next) {
            self.dispatch(target, kind, data, None, s)?;
        }
        Ok(())
    }

    /// focus()/blur() move focus: the listeners run nested in the script.
    fn move_focus_nested(&mut self, next: Option<u64>) {
        for (target, kind, data) in self.focus_events(next) {
            let _ = self.dispatch_nested(target, kind, data, true);
        }
    }

    fn next_listener_registration(&mut self) -> u64 {
        self.listener_registration += 1;
        self.listener_registration
    }

    /// Invoke one host target/phase from its current listener list. A removed
    /// registration stays removed even when the same callback is added again.
    fn dispatch_host_nested_stage(
        &mut self,
        window: bool,
        capture: bool,
        kind: EventKind,
        event: &js::Event,
    ) {
        if kind == EventKind::Submit && event.propagation_stopped() {
            return;
        }
        let registry = if capture {
            &self.capture_listeners
        } else {
            &self.host_listeners
        };
        let calls: Vec<_> = registry
            .iter()
            .filter(|g| g.0 == window && g.1 == kind)
            .map(|g| (g.2.clone(), g.3))
            .collect();
        for (f, registration) in calls {
            let registry = if capture {
                &self.capture_listeners
            } else {
                &self.host_listeners
            };
            let live = registry.iter().any(|g| g.3 == registration);
            let current = if window {
                js::Element::WINDOW
            } else {
                js::Element::DOCUMENT
            };
            if !live || !event.enter(current) {
                continue;
            }
            if let Err(t) = self.call_nested_listener(&f, event) {
                self.uncaught.push(t);
            }
        }
    }

    /// Own one element's current phase listeners, without retaining a tree or
    /// registration-table borrow while application callbacks run.
    fn nested_element_listeners(
        &self,
        current: u64,
        kind: EventKind,
        capture: bool,
    ) -> Vec<(ListenerRef, Option<u64>)> {
        let mut calls = vec![];
        if capture {
            for &(k, l) in self.capture_elements.get(&current).into_iter().flatten() {
                if k == kind {
                    calls.push((self.listeners[l].clone(), None));
                }
            }
        } else {
            if let Some(VNode::Element { listeners, .. }) =
                chain_nodes(&self.last_tree, current).and_then(|nodes| nodes.last().copied())
            {
                for &(k, l) in listeners {
                    if k == kind {
                        calls.push((self.listeners[l].clone(), None));
                    }
                }
            }
            for (_, _, f, registration) in self
                .element_listeners
                .iter()
                .filter(|g| g.0 == current && g.1 == kind)
            {
                calls.push((
                    ListenerRef {
                        instance: 0,
                        handler: 0,
                        args: vec![],
                        closure: Some(f.clone()),
                    },
                    Some(*registration),
                ));
            }
        }
        calls
    }

    fn element_listener_live(
        &self,
        current: u64,
        capture: bool,
        kind: EventKind,
        r: &ListenerRef,
        registration: Option<u64>,
    ) -> bool {
        if let Some(registration) = registration {
            self.element_listeners.iter().any(|g| g.3 == registration)
        } else {
            self.nested_element_listeners(current, kind, capture)
                .iter()
                .any(|(now, id)| {
                    id.is_none()
                        && now.instance == r.instance
                        && now.handler == r.handler
                        && now.args.len() == r.args.len()
                        && now.args.iter().zip(&r.args).all(|(a, b)| a.same(b))
                        && match (&now.closure, &r.closure) {
                            (Some(a), Some(b)) => a.same(b),
                            (None, None) => true,
                            _ => false,
                        }
                })
        }
    }

    fn call_element_listener(&mut self, r: &ListenerRef, event: &js::Event) -> Res<()> {
        match &r.closure {
            Some(f) => self.call_nested_listener(f, event),
            None => self.run(r.instance, r.handler, r.args.clone(), Some(event.clone())),
        }
    }

    fn element_listener_source(&self, r: &ListenerRef) -> Option<Source> {
        self.program.components[self.instances[r.instance].component]
            .handlers
            .get(r.handler)
            .filter(|_| r.closure.is_none())
            .and_then(|h| h.source.clone())
    }

    fn dispatch_element_nested_stage(
        &mut self,
        current: u64,
        capture: bool,
        kind: EventKind,
        event: &js::Event,
    ) {
        if kind == EventKind::Submit && event.propagation_stopped() {
            return;
        }
        let calls = self.nested_element_listeners(current, kind, capture);
        for (r, registration) in calls {
            let live = self.element_listener_live(current, capture, kind, &r, registration);
            if !live || !event.enter(js::Element(current)) {
                continue;
            }
            let result = self.call_element_listener(&r, event);
            if let Err(t) = result {
                self.uncaught.push(t);
            }
        }
    }

    /// Dispatch nested in the running script, with an owned event path and
    /// a fresh snapshot when each target/phase is reached. No task or microtask
    /// checkpoint is inserted; callback exceptions are reported.
    fn dispatch_nested(
        &mut self,
        target: u64,
        kind: EventKind,
        mut data: js::EventData,
        elements: bool,
    ) -> Option<js::Event> {
        let path: Vec<u64> = chain_nodes(&self.last_tree, target)?
            .iter()
            .filter_map(|n| element_id(n))
            .collect();
        data.kind = JsString::from(kind.name());
        data.target = js::Element(target);
        data.cancelable = kind.cancelable();
        let event = js::Event::new(data);
        for window in [true, false] {
            self.dispatch_host_nested_stage(window, true, kind, &event);
        }
        if elements {
            for &current in &path {
                self.dispatch_element_nested_stage(current, true, kind, &event);
            }
            for &current in path
                .iter()
                .rev()
                .take(if kind.bubbles() { path.len() } else { 1 })
            {
                self.dispatch_element_nested_stage(current, false, kind, &event);
            }
        }
        if kind.bubbles() {
            for window in [false, true] {
                self.dispatch_host_nested_stage(window, false, kind, &event);
            }
        }
        event.finish();
        Some(event)
    }

    fn call_nested_listener(&mut self, f: &Val, event: &js::Event) -> Res<()> {
        let outer = (
            std::mem::replace(&mut self.payload, payload_of(event)),
            std::mem::replace(&mut self.event, Some(event.clone())),
        );
        let result = self
            .call_value(f, vec![Val::Event(event.clone())])
            .map(|_| ());
        (self.payload, self.event) = outer;
        result
    }

    /// Only physical form submission uses phase-local element snapshots here.
    /// Other physical events retain their existing dispatch path and checkpoints.
    fn dispatch_submit_path(&mut self, target: u64, s: &mut Run) -> Result<Option<js::Event>> {
        let tree = self.render()?;
        let Some(nodes) = chain_nodes(&tree, target) else {
            return Ok(None);
        };
        let path: Vec<_> = nodes.iter().rev().filter_map(|n| element_id(n)).collect();
        let kind = EventKind::Submit;
        let event = js::Event::new(js::EventData {
            kind: kind.name().into(),
            target: js::Element(target),
            cancelable: kind.cancelable(),
            ..Default::default()
        });
        let stages: Vec<_> = path
            .iter()
            .rev()
            .map(|&current| (current, true))
            .chain(path.iter().map(|&current| (current, false)))
            .collect();
        self.dispatch_capture(kind, &event, true, s);
        // The host capture invocation may finish its same-target listeners,
        // but stopping there never reaches that host target's later bubble
        // invocation after the element path.
        if event.propagation_stopped() {
            event.finish();
            return Ok(Some(event));
        }
        if self.program.schedule.checkpoint == Checkpoint::Listener {
            for (current, capture) in stages {
                if event.propagation_stopped() {
                    break;
                }
                // A callback/checkpoint may change later targets, but this
                // invocation keeps its original owned registration snapshot.
                let calls = self.nested_element_listeners(current, kind, capture);
                for (r, registration) in calls {
                    if !self.element_listener_live(current, capture, kind, &r, registration)
                        || !event.can_enter(js::Element(current))
                    {
                        continue;
                    }
                    let source = self.element_listener_source(&r);
                    let result = self.task(source.as_ref(), true, |m| {
                        if !m.element_listener_live(current, capture, kind, &r, registration)
                            || !event.enter(js::Element(current))
                        {
                            return Ok(());
                        }
                        s.ran = true;
                        m.call_element_listener(&r, &event)
                    });
                    if let Err(d) = result {
                        s.error.get_or_insert(d);
                    }
                }
            }
        } else {
            let source = stages
                .iter()
                .flat_map(|&(current, capture)| {
                    self.nested_element_listeners(current, kind, capture)
                })
                .find_map(|(r, _)| self.element_listener_source(&r));
            let has_calls = !event.propagation_stopped()
                && stages.iter().any(|&(current, capture)| {
                    event.can_enter(js::Element(current))
                        && !self
                            .nested_element_listeners(current, kind, capture)
                            .is_empty()
                });
            if has_calls {
                let result = self.task(source.as_ref(), true, |m| {
                    let mut error = None;
                    for (current, capture) in stages {
                        if event.propagation_stopped() {
                            break;
                        }
                        let calls = m.nested_element_listeners(current, kind, capture);
                        for (r, registration) in calls {
                            if !m.element_listener_live(current, capture, kind, &r, registration)
                                || !event.enter(js::Element(current))
                            {
                                continue;
                            }
                            s.ran = true;
                            if let Err(t) = m.call_element_listener(&r, &event) {
                                if t.name.to_rust() == "RunicDomainError" {
                                    return Err(t);
                                }
                                error.get_or_insert(t);
                            }
                        }
                    }
                    error.map_or(Ok(()), Err)
                });
                if let Err(d) = result {
                    s.error.get_or_insert(d);
                }
            }
        }
        self.dispatch_globals(kind, &event, s);
        event.finish();
        Ok(Some(event))
    }

    /// Dispatch one event at the element `target` if it is rendered: the
    /// listeners on its path (target first, then the ancestors where the
    /// event bubbles) and the target's listeners for `with` (a second event
    /// delivered in the same dispatch), as one task or one task per listener.
    fn dispatch(
        &mut self,
        target: u64,
        kind: EventKind,
        mut data: js::EventData,
        with: Option<(EventKind, js::EventData)>,
        s: &mut Run,
    ) -> Result<Option<js::Event>> {
        let tree = self.render()?;
        let Some(nodes) = chain_nodes(&tree, target) else {
            return Ok(None);
        };
        let target_node = *nodes.last().expect("element chain");
        let fill = |data: &mut js::EventData, kind: EventKind| {
            data.kind = JsString::from(kind.name());
            data.target = js::Element(target);
            data.cancelable = kind.cancelable();
            if let VNode::Element { value, checked, .. } = target_node {
                if kind != EventKind::Input {
                    data.value = JsString::from(value.as_deref().unwrap_or_default());
                }
                if !matches!(kind, EventKind::Click | EventKind::Change) {
                    data.checked = checked.unwrap_or_default();
                }
            }
        };
        fill(&mut data, kind);
        let event = js::Event::new(data);
        let path: Vec<&VNode> = if kind.bubbles() {
            nodes.iter().rev().copied().collect()
        } else {
            vec![target_node]
        };
        let mut entries: Vec<(usize, js::Event, u64)> = vec![];
        // The elements' capture listeners first, from the root to the target
        // (M6 overlays).
        for n in &nodes {
            if let VNode::Element { id, .. } = n {
                for &(k, l) in self.capture_elements.get(id).into_iter().flatten() {
                    if k == kind {
                        entries.push((l, event.clone(), *id));
                    }
                }
            }
        }
        for n in path {
            if let VNode::Element { id, listeners, .. } = n {
                for &(k, l) in listeners {
                    if k == kind {
                        entries.push((l, event.clone(), *id));
                    }
                }
                for f in self.script_listeners(*id, kind) {
                    entries.push((f, event.clone(), *id));
                }
            }
        }
        let mut second = None;
        if let Some((k2, mut d2)) = with {
            fill(&mut d2, k2);
            let e2 = js::Event::new(d2);
            if let VNode::Element { listeners, .. } = target_node {
                for &(k, l) in listeners {
                    if k == k2 {
                        entries.push((l, e2.clone(), target));
                    }
                }
            }
            second = Some(e2);
        }
        let refs: Vec<(ListenerRef, js::Event, u64)> = entries
            .into_iter()
            .map(|(l, e, current)| (self.listeners[l].clone(), e, current))
            .collect();
        s.ran |= !refs.is_empty();
        // The capture listeners of the window, then the document, first,
        // each a callback of its own.
        self.dispatch_capture(kind, &event, true, s);
        // One task per event, or per listener where each listener ends with a
        // microtask checkpoint; an exception does not stop later listeners.
        let tasks: Vec<Vec<(ListenerRef, js::Event, u64)>> =
            if self.program.schedule.checkpoint == Checkpoint::Listener {
                refs.into_iter().map(|r| vec![r]).collect()
            } else if refs.is_empty() {
                vec![]
            } else {
                vec![refs]
            };
        for listeners in tasks {
            let source = {
                let (r, ..) = &listeners[0];
                let c = self.instances[r.instance].component;
                self.program.components[c]
                    .handlers
                    .get(r.handler)
                    .filter(|_| r.closure.is_none())
                    .and_then(|h| h.source.clone())
            };
            // Updates from continuous events (React) are not discrete.
            let kind = listeners[0].1.data().kind.to_rust();
            let discrete = !self
                .program
                .schedule
                .continuous
                .iter()
                .any(|k| k.name() == kind);
            let result = self.task(source.as_ref(), discrete, |m| {
                let mut error = None;
                for (r, event, current) in listeners {
                    if !event.enter(js::Element(current)) {
                        continue;
                    }
                    let result = match &r.closure {
                        Some(f) => m.call_value(f, vec![Val::Event(event)]).map(|_| ()),
                        None => m.run(r.instance, r.handler, r.args, Some(event)),
                    };
                    if let Err(t) = result {
                        if t.name.to_rust() == "RunicDomainError" {
                            return Err(t);
                        }
                        error.get_or_insert(t);
                    }
                }
                error.map_or(Ok(()), Err)
            });
            if let Err(d) = result {
                s.error.get_or_insert(d);
            }
        }
        if kind.bubbles() {
            self.dispatch_globals(kind, &event, s);
        }
        event.finish();
        if let Some(e2) = second {
            let kind = EventKind::parse(&e2.data().kind.to_rust()).expect("event kind");
            self.dispatch_globals(kind, &e2, s);
            e2.finish();
        }
        Ok(Some(event))
    }

    /// Queue a traversal of the session history by `delta` entries.
    /// Traversals queued while one is pending interact in Chromium (a
    /// second may be dropped), which the model does not cover.
    fn traverse(&mut self, delta: i64) -> Res<()> {
        if self
            .host
            .tasks
            .iter()
            .any(|t| matches!(t, HostTask::Traverse(_)))
        {
            return Err(Throw::new(
                "RunicHistoryError",
                "a history traversal while another is pending",
            ));
        }
        self.host.tasks.push_back(HostTask::Traverse(delta));
        Ok(())
    }

    /// A user traversal (the harness's `back` and `forward` actions): the
    /// browser traverses, then the host's work runs. Returns whether a
    /// listener ran.
    pub fn navigate(&mut self, delta: i64) -> Result<bool> {
        self.render()?;
        self.traverse(delta).map_err(throw_diag)?;
        let mut run = Run::default();
        self.host_tasks(&mut run);
        self.focus_fixup(&mut run);
        match run.error {
            Some(d) => Err(d),
            None => Ok(run.ran),
        }
    }

    /// Run the host's queued work, each item a task of its own: clipboard
    /// replies settle their promises, traversals fire `popstate` (and queue
    /// `hashchange` when only the fragment changed).
    fn host_tasks(&mut self, s: &mut Run) {
        while let Some(t) = self.host.tasks.pop_front() {
            let result = match t {
                HostTask::ClipboardWrite(text, p) => self.task(None, false, |m| {
                    m.host.clipboard = well_formed(&text);
                    m.settle_promise(&p, Ok(Val::Undefined));
                    Ok(())
                }),
                HostTask::ClipboardRead(p) => self.task(None, false, |m| {
                    let text = m.host.clipboard.clone();
                    m.settle_promise(&p, Ok(Val::Str(text)));
                    Ok(())
                }),
                HostTask::Traverse(delta) => match self.host.session.traverse(delta) {
                    Ok(Some(t)) => {
                        if t.hashchange {
                            self.host.tasks.push_front(HostTask::HashChange);
                        }
                        self.window_event(EventKind::Popstate, s);
                        Ok(())
                    }
                    Ok(None) => Ok(()),
                    Err(t) => Err(throw_diag(t)),
                },
                HostTask::HashChange => {
                    self.window_event(EventKind::Hashchange, s);
                    Ok(())
                }
                HostTask::Reply(p) => self.task(None, false, |m| {
                    m.settle_promise(&p, Ok(Val::Undefined));
                    Ok(())
                }),
            };
            if let Err(d) = result {
                s.error.get_or_insert(d);
            }
        }
    }

    /// Fire `kind` at the window: its listeners, each a callback of its own.
    fn window_event(&mut self, kind: EventKind, s: &mut Run) {
        let event = js::Event::new(js::EventData {
            kind: JsString::from(kind.name()),
            target: js::Element::WINDOW,
            ..Default::default()
        });
        self.dispatch_capture(kind, &event, false, s);
        self.dispatch_globals(kind, &event, s);
        event.finish();
    }

    /// Fire `kind` at the window nested in the running script (`popstate`
    /// from `location.hash = …`): the listeners run at once, with no
    /// microtask checkpoint; their exceptions are reported.
    fn dispatch_window_nested(&mut self, kind: EventKind) {
        let event = js::Event::new(js::EventData {
            kind: JsString::from(kind.name()),
            target: js::Element::WINDOW,
            ..Default::default()
        });
        let listeners: Vec<Val> = self
            .host_listeners
            .iter()
            .filter(|g| g.0 && g.1 == kind)
            .map(|g| g.2.clone())
            .collect();
        for f in listeners {
            let live = self
                .host_listeners
                .iter()
                .any(|g| g.0 && g.1 == kind && g.2.same(&f));
            if !live || !event.enter(js::Element::WINDOW) {
                continue;
            }
            if let Err(t) = self.call_value(&f, vec![Val::Event(event.clone())]) {
                self.uncaught.push(t);
            }
        }
        event.finish();
    }

    /// After the element path: the document's listeners, then the window's,
    /// each a callback of its own (a microtask checkpoint follows it). A
    /// target's listeners are those registered when the event reaches it;
    /// one removed meanwhile is not called.
    /// Listener table entries (until the next render) for the listeners
    /// script added to element `id` for `kind`, in registration order.
    fn script_listeners(&mut self, id: u64, kind: EventKind) -> Vec<usize> {
        let fs: Vec<Val> = self
            .element_listeners
            .iter()
            .filter(|g| g.0 == id && g.1 == kind)
            .map(|g| g.2.clone())
            .collect();
        fs.into_iter()
            .map(|f| {
                self.listeners.push(ListenerRef {
                    instance: 0,
                    handler: 0,
                    args: vec![],
                    closure: Some(f),
                });
                self.listeners.len() - 1
            })
            .collect()
    }

    /// The capture listeners of the window, then (`document`) the
    /// document's, each a callback of its own.
    fn dispatch_capture(
        &mut self,
        kind: EventKind,
        event: &js::Event,
        document: bool,
        s: &mut Run,
    ) {
        for window in [true, false] {
            if kind == EventKind::Submit && event.propagation_stopped() {
                break;
            }
            if !window && !document {
                continue;
            }
            let current = if window {
                js::Element::WINDOW
            } else {
                js::Element::DOCUMENT
            };
            let listeners: Vec<(Val, u64)> = self
                .capture_listeners
                .iter()
                .filter(|g| g.0 == window && g.1 == kind)
                .map(|g| (g.2.clone(), g.3))
                .collect();
            for (f, registration) in listeners {
                let live = self.capture_listeners.iter().any(|g| g.3 == registration);
                if !live || !event.enter(current) {
                    continue;
                }
                s.ran = true;
                let arg = Val::Event(event.clone());
                let result = self.task(None, true, |m| m.call_value(&f, vec![arg]).map(|_| ()));
                if let Err(d) = result {
                    s.error.get_or_insert(d);
                }
            }
        }
    }

    fn dispatch_globals(&mut self, kind: EventKind, event: &js::Event, s: &mut Run) {
        for window in [false, true] {
            if kind == EventKind::Submit && event.propagation_stopped() {
                break;
            }
            let current = if window {
                js::Element::WINDOW
            } else {
                js::Element::DOCUMENT
            };
            let listeners: Vec<(Val, u64)> = self
                .host_listeners
                .iter()
                .filter(|g| g.0 == window && g.1 == kind)
                .map(|g| (g.2.clone(), g.3))
                .collect();
            for (f, registration) in listeners {
                let live = self.host_listeners.iter().any(|g| g.3 == registration);
                if !live || !event.enter(current) {
                    continue;
                }
                s.ran = true;
                let arg = Val::Event(event.clone());
                let result = self.task(None, true, |m| m.call_value(&f, vec![arg]).map(|_| ()));
                if let Err(d) = result {
                    s.error.get_or_insert(d);
                }
            }
        }
    }
}

/// The entries of a bag that apply: the last of each name, in the order
/// of their first occurrence.
/// Null passed to a prop that takes its default when undefined and is not
/// nullable: the value model cannot hold it (generated code throws alike).
fn null_prop(name: &str) -> Throw {
    Throw::type_error(format!(
        "RunicPropsError: null passed to prop {name}, which is not nullable"
    ))
}

fn resolve_attrs(bag: &[(String, Val)]) -> Vec<(&str, &Val)> {
    let mut out: Vec<(&str, &Val)> = vec![];
    for (name, v) in bag {
        match out.iter_mut().find(|(n, _)| *n == name.as_str()) {
            Some(slot) => slot.1 = v,
            None => out.push((name, v)),
        }
    }
    out
}

/// Bag values for `js::merge_props` (`attrs.merge-props`).
struct MergeVals<'p> {
    program: &'p Program,
}

impl js::MergeOps<Val> for MergeVals<'_> {
    fn kind(&self, v: &Val) -> js::MergeKind {
        match v {
            Val::Undefined => js::MergeKind::Undefined,
            Val::Null => js::MergeKind::Null,
            Val::Str(s) => js::MergeKind::Text(s.clone()),
            Val::Bool(b) => js::MergeKind::Flag(*b),
            Val::Closure(_) | Val::Listeners(_) => js::MergeKind::Function,
            // A style object of keys that may be absent: a map.
            Val::Map(m) => js::MergeKind::Style(
                m.peek()
                    .entries
                    .values()
                    .map(|(k, v)| {
                        (
                            k.string().to_rust(),
                            match v {
                                Val::Str(s) => Some(s.clone()),
                                _ => None,
                            },
                        )
                    })
                    .collect(),
            ),
            // A style object: a record of nullable property values.
            Val::Record(r) => {
                let data = r.peek();
                let rec = &self.program.records[data.record];
                js::MergeKind::Style(
                    rec.fields
                        .iter()
                        .zip(&data.fields)
                        .map(|(f, v)| {
                            (
                                f.name.clone(),
                                match v {
                                    Val::Str(s) => Some(s.clone()),
                                    _ => None,
                                },
                            )
                        })
                        .collect(),
                )
            }
            // A value of another type passed through rest props (M6 overlays).
            _ => js::MergeKind::Other,
        }
    }
    fn text(&self, s: JsString) -> Val {
        Val::Str(s)
    }
    fn compose(&self, listeners: Vec<Val>) -> Val {
        Val::Listeners(Rc::new(listeners))
    }
    fn listeners(&self, v: &Val) -> Vec<Val> {
        match v {
            Val::Listeners(l) => l.to_vec(),
            other => vec![other.clone()],
        }
    }
}

/// Adds an entry to a merging bag (`attrs` with `merge`, as `js::attrs_merge`).
fn merge_attr(out: &mut Vec<(String, Val)>, name: String, v: Val) {
    let text = |v: &Val| match v {
        Val::Str(s) => Some(Some(s.clone())),
        Val::Undefined | Val::Null => Some(None),
        _ => None,
    };
    let slot = out.iter().position(|(n, _)| *n == name);
    // A missing `class` merges like an absent one.
    let prev = match slot {
        Some(i) => text(&out[i].1),
        None => Some(None),
    };
    let v = match (name == "class", prev, text(&v)) {
        (true, Some(a), Some(b)) => match js::class_merge(a.as_ref(), b.as_ref()) {
            Some(s) => Val::Str(s),
            None => Val::Undefined,
        },
        _ => v,
    };
    match slot {
        Some(i) => out[i].1 = v,
        None => out.push((name, v)),
    }
}

/// Outcome of a harness action: whether any listener ran, and the first error.
#[derive(Default)]
struct Run {
    ran: bool,
    error: Option<Diagnostic>,
}

/// The `payload` of a handler running for `event` (the per-kind shorthand).
fn payload_of(event: &js::Event) -> Option<Val> {
    let d = event.data();
    match d.kind.to_rust().as_str() {
        "input" => Some(Val::Str(d.value.clone())),
        "change" => Some(Val::Bool(d.checked)),
        "keydown" => Some(Val::Str(d.key.clone())),
        _ => None,
    }
}

fn form_unsupported(what: &str) -> Throw {
    Throw::new("RunicUnsupportedError", what)
}

fn form_tree_elements(tree: &[VNode]) -> Vec<&VNode> {
    fn walk<'a>(nodes: &'a [VNode], out: &mut Vec<&'a VNode>) {
        for n in nodes {
            if let VNode::Element { children, .. } = n {
                out.push(n);
                walk(children, out);
            }
        }
    }
    let mut out = vec![];
    walk(tree, &mut out);
    out
}

fn is_form(tree: &[VNode], id: u64) -> bool {
    chain_nodes(tree, id)
        .and_then(|n| n.last().copied())
        .is_some_and(|n| matches!(n, VNode::Element { tag, .. } if tag == "form"))
}

fn form_has_attr(tree: &[VNode], id: u64, name: &str) -> bool {
    chain_nodes(tree, id)
        .and_then(|n| n.last().copied())
        .is_some_and(|n| matches!(n, VNode::Element { attrs, .. } if attrs.contains_key(name)))
}

fn form_owner(tree: &[VNode], id: u64) -> Option<u64> {
    let nodes = chain_nodes(tree, id)?;
    let VNode::Element { attrs, .. } = nodes.last().copied()? else {
        return None;
    };
    let ancestor = nodes[..nodes.len() - 1].iter().rev().find_map(|n| match n {
        VNode::Element { tag, id, .. } if tag == "form" => Some(*id),
        _ => None,
    });
    js::forms::form_owner(
        attrs.get("form").map(String::as_str),
        true,
        |name| element_by_id(tree, name).map(|id| (id, is_form(tree, id))),
        ancestor,
    )
}

fn form_control(tree: &[VNode], id: u64) -> Option<js::forms::Control> {
    let nodes = chain_nodes(tree, id)?;
    let VNode::Element { tag, attrs, .. } = nodes.last().copied()? else {
        return None;
    };
    if !matches!(
        tag.as_str(),
        "button" | "input" | "select" | "textarea" | "fieldset" | "output" | "object"
    ) {
        return None;
    }
    let disableable_control = matches!(tag.as_str(), "button" | "input" | "select" | "textarea");
    let disabled = ((disableable_control || tag == "fieldset") && attrs.contains_key("disabled"))
        || (disableable_control
            && nodes.iter().enumerate().any(|(i, n)| {
                let VNode::Element {
                    tag,
                    attrs,
                    children,
                    ..
                } = n
                else {
                    return false;
                };
                if tag != "fieldset" || !attrs.contains_key("disabled") || i + 1 == nodes.len() {
                    return false;
                }
                let legend = children.iter().find_map(|n| match n {
                    VNode::Element { tag, id, .. } if tag == "legend" => Some(*id),
                    _ => None,
                });
                legend.is_none() || element_id(nodes[i + 1]) != legend
            }));
    Some(js::forms::Control {
        id,
        tag: tag.clone(),
        ty: attrs.get("type").cloned(),
        disabled,
        readonly: attrs.contains_key("readonly"),
        in_datalist: nodes[..nodes.len() - 1]
            .iter()
            .any(|n| matches!(n, VNode::Element { tag, .. } if tag == "datalist")),
        constraints: [
            "required",
            "pattern",
            "minlength",
            "maxlength",
            "min",
            "max",
            "step",
        ]
        .into_iter()
        .filter(|name| attrs.contains_key(*name))
        .map(str::to_owned)
        .collect(),
        command: attrs.contains_key("command"),
        command_for: attrs.contains_key("commandfor"),
        parent_is_select: nodes
            .iter()
            .rev()
            .nth(1)
            .is_some_and(|n| matches!(n, VNode::Element { tag, .. } if tag == "select")),
        name: attrs.get("name").cloned(),
        dom_id: attrs.get("id").cloned(),
    })
}

fn form_controls(tree: &[VNode], form: u64) -> Vec<js::forms::Control> {
    form_tree_elements(tree)
        .into_iter()
        .filter_map(|n| {
            let id = element_id(n)?;
            (form_owner(tree, id) == Some(form))
                .then(|| form_control(tree, id))
                .flatten()
        })
        .collect()
}

fn form_request_submit_shadowed(tree: &[VNode], form: u64) -> bool {
    if form_controls(tree, form)
        .iter()
        .any(js::forms::Control::shadows_request_submit)
    {
        return true;
    }
    // HTMLFormElement's legacy named lookup also includes descendant images.
    form_tree_elements(tree).into_iter().any(|n| match n {
        VNode::Element { tag, attrs, id, .. }
            if tag == "img"
                && (attrs.get("name").is_some_and(|s| s == "requestSubmit")
                    || attrs.get("id").is_some_and(|s| s == "requestSubmit")) =>
        {
            chain_nodes(tree, *id).is_some_and(|nodes| {
                nodes[..nodes.len() - 1].iter().rev().find_map(|n| match n {
                    VNode::Element { tag, id, .. } if tag == "form" => Some(*id),
                    _ => None,
                }) == Some(form)
            })
        }
        _ => false,
    })
}

/// A removed subtree no longer gives a reliable live form owner. Reject any
/// descendant named control conservatively, including legacy images.
fn form_subtree_shadows_request_submit(tree: &[VNode]) -> bool {
    form_tree_elements(tree).into_iter().any(|n| match n {
        VNode::Element { tag, attrs, .. } => {
            matches!(
                tag.as_str(),
                "button"
                    | "input"
                    | "select"
                    | "textarea"
                    | "fieldset"
                    | "output"
                    | "object"
                    | "img"
            ) && (attrs.get("name").is_some_and(|s| s == "requestSubmit")
                || attrs.get("id").is_some_and(|s| s == "requestSubmit"))
        }
        _ => false,
    })
}

/// Snapshot the original innermost control; type and owner are resolved later.
fn form_clicked_control(tree: &[VNode], target: u64) -> Option<u64> {
    chain_nodes(tree, target)?
        .iter()
        .rev()
        .find_map(|n| match n {
            VNode::Element { tag, id, .. } if matches!(tag.as_str(), "button" | "input") => {
                Some(*id)
            }
            _ => None,
        })
}

/// The href of the innermost link around target.
fn link_of(tree: &[VNode], target: u64) -> Option<String> {
    chain_nodes(tree, target)?
        .iter()
        .rev()
        .find_map(|n| match n {
            VNode::Element { tag, attrs, .. } if tag == "a" => attrs.get("href").cloned(),
            _ => None,
        })
}

/// Whether an element of `tree` is the target of the fragment `name`: an
/// element with that `id`, or an `<a>` with that `name`.
fn fragment_target(tree: &[VNode], name: &str) -> bool {
    tree.iter().any(|n| match n {
        VNode::Element {
            tag,
            attrs,
            children,
            ..
        } => {
            attrs.get("id").is_some_and(|v| v == name)
                || (tag == "a" && attrs.get("name").is_some_and(|v| v == name))
                || fragment_target(children, name)
        }
        VNode::Text(_) => false,
    })
}

/// A URL fragment percent-decoded as UTF-8 (lossy), as the HTML standard
/// decodes it to find the element a fragment names.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The element a press on the chain `nodes` (root first) focuses: the
/// innermost control, link or element with a `tabindex`; none when that is
/// a disabled control or there is none.
fn focus_target(nodes: &[&VNode]) -> Option<u64> {
    let found = nodes.iter().rev().find(|n| {
        matches!(n, VNode::Element { tag, attrs, .. } if matches!(tag.as_str(), "button" | "input" | "textarea" | "select") || (tag == "a" && attrs.contains_key("href")) || attrs.contains_key("tabindex"))
    })?;
    match found {
        VNode::Element { tag, attrs, id, .. } => {
            let disabled = matches!(tag.as_str(), "button" | "input" | "textarea" | "select")
                && attrs.contains_key("disabled");
            (!disabled).then_some(*id)
        }
        VNode::Text(_) => None,
    }
}

/// The radio buttons of `radio`'s group (the same non-empty name; itself
/// alone without one), in tree order, with their checked state.
fn radio_group(tree: &[VNode], radio: u64) -> Vec<(u64, bool)> {
    fn walk(nodes: &[VNode], name: &str, out: &mut Vec<(u64, bool)>) {
        for n in nodes {
            if let VNode::Element {
                tag,
                attrs,
                checked,
                id,
                children,
                ..
            } = n
            {
                if tag == "input"
                    && attrs.get("type").is_some_and(|t| t == "radio")
                    && attrs.get("name").is_some_and(|x| x == name)
                {
                    out.push((*id, checked.unwrap_or(false)));
                }
                walk(children, name, out);
            }
        }
    }
    let name = chain_nodes(tree, radio).and_then(|n| match n.last() {
        Some(VNode::Element { attrs, checked, .. }) => attrs
            .get("name")
            .filter(|n| !n.is_empty())
            .cloned()
            .ok_or(checked.unwrap_or(false))
            .ok(),
        _ => None,
    });
    match name {
        Some(name) => {
            let mut out = vec![];
            walk(tree, &name, &mut out);
            out
        }
        None => chain_nodes(tree, radio)
            .and_then(|n| match n.last() {
                Some(VNode::Element { checked, .. }) => {
                    Some(vec![(radio, checked.unwrap_or(false))])
                }
                _ => None,
            })
            .unwrap_or_default(),
    }
}

/// The enabled radio buttons of the group (and `radio` itself).
fn radio_group_enabled(tree: &[VNode], radio: u64) -> Vec<u64> {
    radio_group(tree, radio)
        .into_iter()
        .map(|(r, _)| r)
        .filter(|&r| {
            r == radio
                || chain_nodes(tree, r).and_then(|n| n.last().copied()).is_some_and(
                    |n| matches!(n, VNode::Element { attrs, .. } if !attrs.contains_key("disabled")),
                )
        })
        .collect()
}

fn labelable(n: &VNode) -> bool {
    matches!(n, VNode::Element { tag, .. } if matches!(tag.as_str(), "button" | "input" | "textarea" | "select"))
}

/// The control a click on `target` activates through a label: none when
/// the click is on interactive content inside the label; otherwise the
/// label's `for` element if labelable, or else its first labelable descendant.
fn labelled_control(tree: &[VNode], target: u64) -> Option<u64> {
    let chain = chain_nodes(tree, target)?;
    let mut label = None;
    for n in chain.iter().rev() {
        if labelable(n) {
            return None;
        }
        if matches!(n, VNode::Element { tag, .. } if tag == "label") {
            label = Some(*n);
            break;
        }
    }
    let VNode::Element {
        attrs, children, ..
    } = label?
    else {
        return None;
    };
    fn first(nodes: &[VNode], f: &dyn Fn(&VNode) -> bool) -> Option<u64> {
        for n in nodes {
            if let VNode::Element { id, children, .. } = n {
                if f(n) {
                    return Some(*id);
                }
                if let Some(found) = first(children, f) {
                    return Some(found);
                }
            }
        }
        None
    }
    match attrs.get("for") {
        Some(id) => first(
            tree,
            &|n| matches!(n, VNode::Element { attrs, .. } if attrs.get("id") == Some(id)),
        )
        .filter(|&c| {
            chain_nodes(tree, c)
                .and_then(|n| n.last().copied())
                .is_some_and(labelable)
        }),
        None => first(children, &labelable),
    }
}

/// The option a key moves a closed select to (Linux Chromium; see the
/// runtime's select module): arrows to the previous/next enabled option,
/// Home/End to the first/last enabled one, a character to the next option
/// starting with it (wrapping). None when the selection does not change.
fn select_key_target(tree: &[VNode], select: u64, key: &str) -> Option<String> {
    let (options, value) = select_options(tree, select)?;
    let current = options.iter().position(|o| Some(&o.0) == value.as_ref());
    let found = option_key(&options, current, key)?;
    (Some(found) != current).then(|| options[found].0.clone())
}

/// Where a key moves an open popup's highlight (by option index).
fn popup_key(tree: &[VNode], select: u64, from: Option<usize>, key: &str) -> Option<usize> {
    let (options, _) = select_options(tree, select)?;
    option_key(&options, from, key)
}

/// The option a key leads to from `current`: arrows to the previous/next
/// enabled option, Home/End to the first/last enabled one, a character to
/// the next option starting with it (wrapping).
fn option_key(
    options: &[(String, bool, String)],
    current: Option<usize>,
    key: &str,
) -> Option<usize> {
    let n = options.len();
    match key {
        "ArrowDown" => (current.map_or(0, |c| c + 1)..n).find(|&i| options[i].1),
        "ArrowUp" => (0..current?).rev().find(|&i| options[i].1),
        "Home" => (0..n).find(|&i| options[i].1),
        "End" => (0..n).rev().find(|&i| options[i].1),
        k if k.chars().count() == 1 && k != " " => {
            let c = k.to_lowercase();
            let start = current.map_or(0, |c| c + 1);
            (0..n)
                .map(|d| (start + d) % n)
                .find(|&i| options[i].1 && options[i].2.trim_start().to_lowercase().starts_with(&c))
        }
        _ => None,
    }
}

/// A select's options (value, enabled, text) and its value.
#[allow(clippy::type_complexity)]
fn select_options(
    tree: &[VNode],
    select: u64,
) -> Option<(Vec<(String, bool, String)>, Option<String>)> {
    let nodes = chain_nodes(tree, select)?;
    let VNode::Element {
        tag,
        value,
        children,
        ..
    } = nodes.last()?
    else {
        return None;
    };
    if tag != "select" {
        return None;
    }
    let options = children
        .iter()
        .filter_map(|k| match k {
            VNode::Element {
                tag,
                attrs,
                children,
                ..
            } if tag == "option" => {
                let text: String = children.iter().map(text_of).collect();
                Some((
                    attrs
                        .get("value")
                        .cloned()
                        .unwrap_or_else(|| collapse_ascii_whitespace(&text)),
                    !attrs.contains_key("disabled"),
                    text,
                ))
            }
            _ => None,
        })
        .collect();
    Some((options, value.clone()))
}

/// Whether an element of `tag` rendered without template children is a
/// script host (rule O3a, docs/design/M6-SCRIPT-DOM.md): not a control,
/// a void element or SVG, whose children the runtime or the renderer own.
pub fn script_host_tag(tag: &str) -> bool {
    !matches!(
        tag,
        "textarea"
            | "select"
            | "option"
            | "input"
            | "img"
            | "br"
            | "hr"
            | "col"
            | "colgroup"
            | "table"
            | "thead"
            | "tbody"
            | "tfoot"
            | "tr"
    ) && !crate::validate::SVG_TAGS.contains(&tag)
}

/// The text of a node.
fn text_of(n: &VNode) -> String {
    match n {
        VNode::Text(t) => t.clone(),
        VNode::Element { children, .. } => children.iter().map(text_of).collect(),
    }
}

/// HTML's "strip and collapse ASCII whitespace".
fn collapse_ascii_whitespace(s: &str) -> String {
    s.split([' ', '\t', '\n', '\x0c', '\r'])
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn element_id(n: &VNode) -> Option<u64> {
    match n {
        VNode::Element { id, .. } => Some(*id),
        VNode::Text(_) => None,
    }
}

/// The first element in tree order whose `id` attribute is `id`
/// (`document.getElementById`).
fn element_by_id(tree: &[VNode], id: &str) -> Option<u64> {
    for n in tree {
        if let VNode::Element {
            id: here,
            attrs,
            children,
            ..
        } = n
        {
            if attrs.get("id").is_some_and(|v| v == id) {
                return Some(*here);
            }
            if let Some(found) = element_by_id(children, id) {
                return Some(found);
            }
        }
    }
    None
}

/// The nodes from the root to the element with id `id`.
/// The elements matching `selector` among the descendants of element `id`,
/// in tree order. Paths start at `<html>`, `<body>` and the root container
/// (as in the document the runtime builds).
fn query_selector_all(tree: &[VNode], id: u64, selector: &js::Selector) -> Vec<u64> {
    query_selector_all_in(
        tree,
        id,
        selector,
        &[
            ("html", None),
            ("body", None),
            ("div", Some(("id", "root"))),
        ],
    )
}

/// `query_selector_all` in a tree whose top-level nodes have the ancestors
/// `outer` (M6 script DOM: a script tree before the container has the html
/// and body elements; one not in the document none).
#[allow(clippy::type_complexity)]
fn query_selector_all_in(
    tree: &[VNode],
    id: u64,
    selector: &js::Selector,
    outer: &[(&'static str, Option<(&'static str, &'static str)>)],
) -> Vec<u64> {
    enum View<'a> {
        Outer(&'static str, Option<(&'static str, &'static str)>),
        Node(&'a VNode),
    }
    impl js::SelElement for View<'_> {
        fn tag(&self) -> &str {
            match self {
                View::Outer(t, _) => t,
                View::Node(VNode::Element { tag, .. }) => tag,
                View::Node(_) => "",
            }
        }
        fn attr(&self, name: &str) -> Option<&str> {
            match self {
                View::Outer(_, a) => a.filter(|(n, _)| *n == name).map(|(_, v)| v),
                View::Node(VNode::Element { attrs, .. }) => attrs.get(name).map(String::as_str),
                View::Node(_) => None,
            }
        }
    }
    fn walk<'a>(
        nodes: &'a [VNode],
        path: &mut Vec<View<'a>>,
        selector: &js::Selector,
        out: &mut Vec<u64>,
    ) {
        for n in nodes {
            if let VNode::Element { id, children, .. } = n {
                path.push(View::Node(n));
                if selector.matches(path) {
                    out.push(*id);
                }
                walk(children, path, selector, out);
                path.pop();
            }
        }
    }
    let Some(chain) = chain_nodes(tree, id) else {
        return vec![];
    };
    let mut path: Vec<View> = outer.iter().map(|(t, a)| View::Outer(t, *a)).collect();
    path.extend(chain.iter().map(|n| View::Node(n)));
    let mut out = vec![];
    if let Some(VNode::Element { children, .. }) = chain.last() {
        walk(children, &mut path, selector, &mut out);
    }
    out
}

/// `element.closest(selector)` over the interpreter's document (see
/// `document_query`): the nearest inclusive ancestor matching; the body
/// where only it matches, and unsupported where the container or the html
/// element would be the match.
fn closest(
    tree: &[VNode],
    root_len: usize,
    id: u64,
    selector: &js::Selector,
) -> std::result::Result<Option<u64>, Throw> {
    enum View<'a> {
        Outer(&'static str, Option<(&'static str, &'static str)>),
        Node(&'a VNode),
    }
    impl js::SelElement for View<'_> {
        fn tag(&self) -> &str {
            match self {
                View::Outer(t, _) => t,
                View::Node(VNode::Element { tag, .. }) => tag,
                View::Node(_) => "",
            }
        }
        fn attr(&self, name: &str) -> Option<&str> {
            match self {
                View::Outer(_, a) => a.filter(|(n, _)| *n == name).map(|(_, v)| v),
                View::Node(VNode::Element { attrs, .. }) => attrs.get(name).map(String::as_str),
                View::Node(_) => None,
            }
        }
    }
    let Some(chain) = chain_nodes(tree, id) else {
        return Ok(None);
    };
    let split = root_len.min(tree.len());
    let in_root = chain
        .first()
        .is_some_and(|first| tree[..split].iter().any(|n| std::ptr::eq(n, *first)));
    let mut path = vec![View::Outer("html", None), View::Outer("body", None)];
    if in_root {
        path.push(View::Outer("div", Some(("id", "root"))));
    }
    let outer = path.len();
    path.extend(chain.iter().map(|n| View::Node(n)));
    for end in (outer..path.len()).rev() {
        if selector.matches(&path[..=end]) {
            let View::Node(VNode::Element { id, .. }) = path[end] else {
                unreachable!("program elements")
            };
            return Ok(Some(*id));
        }
    }
    let unsupported = |what: &str| {
        Err(Throw::new(
            "RunicUnsupportedError",
            format!("closest matched the {what}, which the interpreter does not model"),
        ))
    };
    if in_root && selector.matches(&path[..3]) {
        return unsupported("container");
    }
    if selector.matches(&path[..2]) {
        return Ok(Some(js::Element::BODY.0));
    }
    if selector.matches(&path[..1]) {
        return unsupported("html element");
    }
    Ok(None)
}

/// `document.querySelector` over the interpreter's document: `html`,
/// `head`, `body`, the container `div#root` with the root's nodes, then
/// the content mounted in the body (after the first `root_len` nodes). The
/// html element, the head and the container are not program elements: a
/// selector matching one of them first is unsupported here.
fn document_query(
    tree: &[VNode],
    root_len: usize,
    preceding: &[VNode],
    selector: &js::Selector,
) -> std::result::Result<Option<u64>, Throw> {
    struct Outer(&'static str, Option<(&'static str, &'static str)>);
    enum View<'a> {
        Outer(Outer),
        Node(&'a VNode),
    }
    impl js::SelElement for View<'_> {
        fn tag(&self) -> &str {
            match self {
                View::Outer(o) => o.0,
                View::Node(VNode::Element { tag, .. }) => tag,
                View::Node(_) => "",
            }
        }
        fn attr(&self, name: &str) -> Option<&str> {
            match self {
                View::Outer(o) => o.1.filter(|(n, _)| *n == name).map(|(_, v)| v),
                View::Node(VNode::Element { attrs, .. }) => attrs.get(name).map(String::as_str),
                View::Node(_) => None,
            }
        }
    }
    fn first<'a>(nodes: &'a [VNode], path: &mut Vec<View<'a>>, s: &js::Selector) -> Option<u64> {
        for n in nodes {
            if let VNode::Element { id, children, .. } = n {
                path.push(View::Node(n));
                if s.matches(path) {
                    return Some(*id);
                }
                let found = first(children, path, s);
                path.pop();
                if found.is_some() {
                    return found;
                }
            }
        }
        None
    }
    let unsupported = |what: &str| -> std::result::Result<Option<u64>, Throw> {
        Err(Throw::new(
            "RunicUnsupportedError",
            format!(
                "document.querySelector matched the {what}, which the interpreter does not model"
            ),
        ))
    };
    let html = || View::Outer(Outer("html", None));
    if selector.matches(&[html()]) {
        return unsupported("html element");
    }
    if selector.matches(&[html(), View::Outer(Outer("head", None))]) {
        return unsupported("head element");
    }
    let body = || View::Outer(Outer("body", None));
    if selector.matches(&[html(), body()]) {
        return Ok(Some(js::Element::BODY.0));
    }
    // Script content before the container (M6 script DOM).
    let mut path = vec![html(), body()];
    if let Some(found) = first(preceding, &mut path, selector) {
        return Ok(Some(found));
    }
    let container = View::Outer(Outer("div", Some(("id", "root"))));
    let mut path = vec![html(), body(), container];
    if selector.matches(&path) {
        return unsupported("container");
    }
    let split = root_len.min(tree.len());
    if let Some(found) = first(&tree[..split], &mut path, selector) {
        return Ok(Some(found));
    }
    let mut path = vec![html(), body()];
    Ok(first(&tree[split..], &mut path, selector))
}

fn chain_nodes(tree: &[VNode], id: u64) -> Option<Vec<&VNode>> {
    fn walk<'t>(nodes: &'t [VNode], id: u64, out: &mut Vec<&'t VNode>) -> bool {
        for n in nodes {
            if let VNode::Element {
                id: here, children, ..
            } = n
            {
                out.push(n);
                if *here == id || walk(children, id, out) {
                    return true;
                }
                out.pop();
            }
        }
        false
    }
    let mut out = vec![];
    walk(tree, id, &mut out).then_some(out)
}

/// An event target: an element id (the first in tree order), the n-th
/// element (in tree order, modulo their number) listening for an event the
/// action delivers ([`EventKind::action`]), or a child-index path.
#[derive(Clone, Copy, Debug)]
pub enum Target<'a> {
    Id(&'a str),
    Nth(&'a str, usize),
    Path(&'a [usize]),
    /// A probe's element-only path, asserted against this action's own live
    /// tree. This delegates endpoint selection, never event behavior or state.
    ElementPath {
        ordinals: &'a [usize],
        tag: &'a str,
        id: Option<&'a str>,
    },
}

/// Child-index path of the target element.
fn locate(tree: &[VNode], target: &Target<'_>) -> Option<Vec<usize>> {
    fn walk(
        nodes: &[VNode],
        path: &mut Vec<usize>,
        visit: &mut dyn FnMut(&VNode, &[usize]) -> bool,
    ) -> bool {
        for (i, n) in nodes.iter().enumerate() {
            path.push(i);
            if let VNode::Element { children, .. } = n {
                if visit(n, path) || walk(children, path, visit) {
                    return true;
                }
            }
            path.pop();
        }
        false
    }
    let mut path = vec![];
    match target {
        Target::ElementPath { ordinals, tag, id } => {
            if ordinals.is_empty() { return None; }
            let mut nodes = tree;
            for (at, &ordinal) in ordinals.iter().enumerate() {
                let (index, node) = nodes.iter().enumerate()
                    .filter(|(_, n)| matches!(n, VNode::Element { .. }))
                    .nth(ordinal)?;
                path.push(index);
                let VNode::Element { tag: actual_tag, attrs, children, .. } = node else {
                    unreachable!("filtered elements")
                };
                if at + 1 == ordinals.len() &&
                    (actual_tag != tag || attrs.get("id").map(String::as_str) != *id) {
                    return None;
                }
                nodes = children;
            }
            Some(path)
        }
        Target::Path(p) => {
            let nodes = path_nodes_checked(tree, p)?;
            matches!(nodes.last(), Some(VNode::Element { .. })).then(|| p.to_vec())
        }
        Target::Id(id) => walk(tree, &mut path, &mut |n, _| {
            matches!(n, VNode::Element { attrs, .. } if attrs.get("id").map(String::as_str) == Some(*id))
        })
        .then_some(path),
        Target::Nth(action, k) => {
            // Selects are targets of `choose`, not of the other actions.
            let listens = |n: &VNode| match n {
                VNode::Element { tag, listeners, .. } if *action == "choose" => {
                    tag == "select"
                        && listeners
                            .iter()
                            .any(|(e, _)| matches!(e.action(), "click" | "input"))
                }
                VNode::Element { tag, listeners, .. } => {
                    tag != "select" && listeners.iter().any(|(e, _)| e.action() == *action)
                }
                VNode::Text(_) => false,
            };
            let mut all = vec![];
            walk(tree, &mut path, &mut |n, p| {
                if listens(n) {
                    all.push(p.to_vec());
                }
                false
            });
            if all.is_empty() {
                None
            } else {
                let i = k % all.len();
                Some(all.swap_remove(i))
            }
        }
    }
}

fn path_nodes_checked<'t>(tree: &'t [VNode], path: &[usize]) -> Option<Vec<&'t VNode>> {
    let mut out = vec![];
    let mut level = tree;
    for &i in path {
        let n = level.get(i)?;
        out.push(n);
        level = match n {
            VNode::Element { children, .. } => children,
            VNode::Text(_) => &[],
        };
    }
    Some(out)
}

fn path_nodes<'t>(tree: &'t [VNode], path: &[usize]) -> Vec<&'t VNode> {
    path_nodes_checked(tree, path).expect("valid path")
}

/// JSON view of a cell value (non-finite numbers as strings), matching the
/// native probe's `cells` output.
/// The members a downcast to `ty` accepts, where it converts a union
/// (its target is a member or a narrower union: M6 unions). Class
/// downcasts target class types; union members are plain records.
fn union_target<'t>(ty: &'t Type, p: &Program) -> Option<&'t [Type]> {
    let t = match ty {
        Type::Maybe(t) => t,
        t => t,
    };
    match t {
        Type::Union(ms) => Some(ms),
        Type::Number | Type::String | Type::Boolean | Type::Element => {
            Some(std::slice::from_ref(t))
        }
        Type::Record(r) if !p.records[*r].class => Some(std::slice::from_ref(t)),
        _ => None,
    }
}

/// Whether `v` is a value of union member `m`.
pub(crate) fn val_is(v: &Val, m: &Type) -> bool {
    match (v, m) {
        (Val::Num(_), Type::Number)
        | (Val::Str(_), Type::String)
        | (Val::Bool(_), Type::Boolean)
        | (Val::Element(_), Type::Element) => true,
        (Val::Record(r), Type::Record(want)) => r.peek().record == *want,
        _ => false,
    }
}

/// The TypeError message of a failing union downcast (the generated code's
/// `js::union_message`).
fn union_message(v: &Val, want: &[Type]) -> String {
    let have = match v {
        Val::Num(_) => "number",
        Val::Str(_) => "string",
        Val::Bool(_) => "boolean",
        Val::Element(_) => "element",
        _ => "object",
    };
    js::union_message(have, &want.iter().map(Type::name).collect::<Vec<_>>())
}

pub fn cell_json(v: &Val) -> Json {
    if let Some(j) = dynamic::cell_json(v) {
        return j;
    }
    match v {
        Val::Undefined => Json::Null,
        Val::Null => Json::Null,
        Val::Bool(b) => json!(b),
        Val::Num(n) if n.is_finite() => json!(n),
        Val::Num(n) => json!(runic_js::number_to_string(*n)),
        Val::Str(s) => json!(s.to_rust()),
        // A value that contains itself shows as "[Circular]".
        Val::Array(a) => match a.visit() {
            None => json!("[Circular]"),
            Some(_v) => Json::Array(a.borrow().iter().map(cell_json).collect()),
        },
        Val::Record(r) => match r.visit() {
            None => json!("[Circular]"),
            Some(_v) => Json::Array(r.borrow().fields.iter().map(cell_json).collect()),
        },
        Val::Map(m) => match m.visit() {
            None => json!("[Circular]"),
            Some(_v) => Json::Array(
                m.borrow()
                    .entries
                    .values()
                    .map(|(k, x)| json!([cell_json(k), cell_json(x)]))
                    .collect(),
            ),
        },
        Val::Set(s) => match s.visit() {
            None => json!("[Circular]"),
            Some(_v) => Json::Array(s.borrow().entries.values().map(cell_json).collect()),
        },
        Val::Closure(_) | Val::Resolver(_) | Val::Listeners(_) => json!("function"),
        Val::Promise(_) => json!("promise"),
        // Element ids differ between the interpreter and the native app.
        Val::Element(_) => json!("element"),
        Val::Event(_) => json!("event"),
        Val::RegExp(r) => json!(js::ToJsString::to_js_string(r).to_rust()),
        Val::MediaQuery(_) => json!("media-query"),
        // A Date as its ISO string (or "Invalid Date").
        Val::Date(d) => {
            json!(js::date::to_json(d.time()).map_or("Invalid Date".into(), |s| s.to_rust()))
        }
        Val::Attrs(_) => json!("attrs"),
        Val::Mounted(_) => json!("mounted"),
        Val::Contexts(_) => json!("contexts"),
        Val::Image(_) => json!("image"),
        Val::DynObject(_) | Val::Boxed(_) | Val::DynFn(_) => unreachable!("dynamic::cell_json"),
    }
}

fn math(m: &str, x: &[f64]) -> f64 {
    use js::math::*;
    let a = || x[0];
    match m {
        "PI" => std::f64::consts::PI,
        "E" => std::f64::consts::E,
        "LN2" => std::f64::consts::LN_2,
        "LN10" => std::f64::consts::LN_10,
        "LOG2E" => std::f64::consts::LOG2_E,
        "LOG10E" => std::f64::consts::LOG10_E,
        "SQRT1_2" => std::f64::consts::FRAC_1_SQRT_2,
        "SQRT2" => std::f64::consts::SQRT_2,
        "abs" => abs(a()),
        "acos" => acos(a()),
        "acosh" => acosh(a()),
        "asin" => asin(a()),
        "asinh" => asinh(a()),
        "atan" => atan(a()),
        "atanh" => atanh(a()),
        "cbrt" => cbrt(a()),
        "ceil" => ceil(a()),
        "clz32" => clz32(a()),
        "cos" => cos(a()),
        "cosh" => cosh(a()),
        "exp" => exp(a()),
        "expm1" => expm1(a()),
        "floor" => floor(a()),
        "fround" => fround(a()),
        "log" => log(a()),
        "log10" => log10(a()),
        "log1p" => log1p(a()),
        "log2" => log2(a()),
        "round" => round(a()),
        "sign" => sign(a()),
        "sin" => sin(a()),
        "sinh" => sinh(a()),
        "sqrt" => sqrt(a()),
        "tan" => tan(a()),
        "tanh" => tanh(a()),
        "trunc" => trunc(a()),
        "atan2" => atan2(x[0], x[1]),
        "imul" => imul(x[0], x[1]),
        "pow" => pow(x[0], x[1]),
        "min" => min(x),
        "max" => max(x),
        "hypot" => hypot(x),
        other => unreachable!("validated Math member {other}"),
    }
}

trait MapVal<T> {
    fn map_val(self, f: impl FnOnce(T) -> Val) -> Maybe<Val>;
}
impl<T> MapVal<T> for Maybe<T> {
    fn map_val(self, f: impl FnOnce(T) -> Val) -> Maybe<Val> {
        match self {
            Maybe::Some(v) => Maybe::Some(f(v)),
            Maybe::Null => Maybe::Null,
            Maybe::Undefined => Maybe::Undefined,
        }
    }
}

pub fn find<'a>(nodes: &'a [VNode], id: &str) -> Option<&'a VNode> {
    nodes.iter().find_map(|n| match n {
        VNode::Element {
            attrs, children, ..
        } => {
            if attrs.get("id").map(String::as_str) == Some(id) {
                Some(n)
            } else {
                find(children, id)
            }
        }
        VNode::Text(_) => None,
    })
}

/// The ids of the elements in `nodes` and their descendants.
fn element_ids(nodes: &[VNode], out: &mut HashSet<u64>) {
    for n in nodes {
        if let VNode::Element { id, children, .. } = n {
            out.insert(*id);
            element_ids(children, out);
        }
    }
}

/// Set the live checked state of element `id` in a rendered tree.
fn set_tree_checked(nodes: &mut [VNode], id: u64, on: bool) -> bool {
    for n in nodes {
        if let VNode::Element {
            id: i,
            checked,
            children,
            ..
        } = n
        {
            if *i == id {
                *checked = Some(on);
                return true;
            }
            if set_tree_checked(children, id, on) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod resolved_pointer_tests {
    use super::*;

    fn element(tag: &str, id: Option<&str>, children: Vec<VNode>) -> VNode {
        VNode::Element {
            tag: tag.into(),
            attrs: id.into_iter().map(|id| ("id".into(), id.into())).collect(),
            value: None,
            checked: None,
            id: 0,
            listeners: vec![],
            children,
        }
    }

    fn tree() -> Vec<VNode> {
        vec![
            VNode::Text(" ".into()),
            element(
                "ul",
                Some("list"),
                vec![
                    VNode::Text("".into()),
                    element(
                        "li",
                        Some("item"),
                        vec![
                            VNode::Text("text ".into()),
                            element("span", Some("label"), vec![]),
                        ],
                    ),
                ],
            ),
            element("p", None, vec![]),
        ]
    }

    #[test]
    fn element_ordinals_ignore_text_and_keep_existing_raw_path_semantics() {
        assert_eq!(
            locate(
                &tree(),
                &Target::ElementPath {
                    ordinals: &[0, 0, 0],
                    tag: "span",
                    id: Some("label")
                }
            ),
            Some(vec![1, 1, 1])
        );
        assert_eq!(
            locate(
                &tree(),
                &Target::ElementPath {
                    ordinals: &[1],
                    tag: "p",
                    id: None
                }
            ),
            Some(vec![2])
        );
    }

    #[test]
    fn a_stale_identity_or_missing_element_never_resolves() {
        for target in [
            Target::ElementPath {
                ordinals: &[0, 0, 0],
                tag: "li",
                id: Some("label"),
            },
            Target::ElementPath {
                ordinals: &[0, 0, 0],
                tag: "span",
                id: Some("other"),
            },
            Target::ElementPath {
                ordinals: &[0, 0, 1],
                tag: "span",
                id: Some("label"),
            },
            Target::ElementPath {
                ordinals: &[],
                tag: "ul",
                id: Some("list"),
            },
        ] {
            assert!(locate(&tree(), &target).is_none());
        }
    }
}

#[cfg(test)]
mod form_submission_tests {
    use super::*;

    fn listener_program(functions: serde_json::Value, target_digit: Option<u32>) -> Program {
        let mut body = vec![];
        if let Some(digit) = target_digit {
            body.push(trace(digit));
        }
        body.push(json!({"op": "expr", "value": {"op": "builtin", "name": "event.preventDefault", "type": "void", "args": [{"op": "event"}]}}));
        serde_json::from_value(json!({
            "schema": 5,
            "meta": {"title": "listener stages", "sourceHash": "test", "frontend": {}},
            "capabilities": [], "styles": {"css": ""}, "root": 0,
            "functions": functions,
            "components": [{"name": "Test", "template": [], "cells": [
                {"name": "trace", "type": "number", "init": {"op": "lit", "value": 0}},
                {"name": "changed", "type": "boolean", "init": {"op": "lit", "value": false}}
            ], "handlers": [{"event": "submit", "body": body}]}]
        }))
        .unwrap()
    }

    fn trace(digit: u32) -> serde_json::Value {
        json!({"op": "set", "cell": 0, "value": {"op": "add", "left": {
            "op": "mul", "left": {"op": "cell", "cell": 0}, "right": {"op": "lit", "value": 10}
        }, "right": {"op": "lit", "value": digit}}})
    }

    fn registration(method: &str, function: usize) -> serde_json::Value {
        json!({"op": "expr", "value": {"op": "builtin", "name": method, "type": "void", "args": [
            {"op": "lit", "value": "submit"}, {"op": "closure", "function": function, "captures": [], "stable": true}
        ]}})
    }

    fn listener_function(name: &str, body: Vec<serde_json::Value>) -> serde_json::Value {
        json!({"name": name, "component": 0, "params": [], "result": "void", "body": body})
    }

    fn install_form(machine: &mut Machine<'_>) {
        machine.last_tree = vec![VNode::Element {
            tag: "form".into(),
            attrs: BTreeMap::new(),
            value: None,
            checked: None,
            id: 1,
            listeners: vec![(EventKind::Submit, 0)],
            children: vec![],
        }];
        machine.listeners.push(ListenerRef {
            instance: 0,
            handler: 0,
            args: vec![],
            closure: None,
        });
        machine.known_forms.insert(1);
        // Keep callback identity stable independently of registration identity.
        for function in 0..machine.program.functions.len() {
            machine.stable_fns.insert(
                (Some(0), function),
                Val::Closure(Rc::new(Closure {
                    function,
                    captures: vec![],
                    instance: Some(0),
                    snapshot: None,
                })),
            );
        }
    }

    fn install_host_listener(machine: &mut Machine<'_>, function: usize, capture: bool) {
        let f = machine.stable_fns[&(Some(0), function)].clone();
        machine
            .builtin(
                if capture {
                    "document.listen-capture"
                } else {
                    "document.listen"
                },
                vec![Val::Str("submit".into()), f],
                &[],
                &Type::Void,
            )
            .unwrap();
    }

    #[test]
    fn capture_added_bubble_listener_participates_in_the_same_submit() {
        let program = listener_program(
            json!([
                listener_function(
                    "capture",
                    vec![trace(1), registration("document.listen", 2)]
                ),
                listener_function("existing bubble", vec![trace(3)]),
                listener_function("added bubble", vec![trace(4)])
            ]),
            Some(2),
        );
        let mut machine = Machine::new(&program).unwrap();
        install_form(&mut machine);
        install_host_listener(&mut machine, 0, true);
        install_host_listener(&mut machine, 1, false);
        machine.request_submit(1).unwrap();
        assert!(matches!(machine.instances[0].cells[0], Val::Num(1234.0)));
        assert!(machine.submitting_forms.is_empty());
        assert!(machine.uncaught.is_empty());
    }

    fn invoke_listener_test_submit(machine: &mut Machine<'_>, physical: bool) {
        if physical {
            let event = js::Event::new(js::EventData {
                kind: "submit".into(),
                target: js::Element(1),
                cancelable: true,
                ..Default::default()
            });
            let mut run = Run::default();
            machine.dispatch_globals(EventKind::Submit, &event, &mut run);
            event.finish();
            assert!(run.error.is_none());
        } else {
            machine.request_submit(1).unwrap();
        }
    }

    #[test]
    fn removed_and_replaced_nested_and_physical_host_registrations_wait_for_the_next_submit() {
        for physical in [false, true] {
            for replacement in [1, 2] {
                let program = listener_program(
                    json!([
                        listener_function(
                            "first",
                            vec![
                                trace(1),
                                json!({"op": "if", "test": {
                    "op": "not", "arg": {"op": "cell", "cell": 1}
                }, "then": [
                    {"op": "set", "cell": 1, "value": {"op": "lit", "value": true}},
                    registration("document.unlisten", 1), registration("document.listen", replacement)
                ], "else": []})
                            ]
                        ),
                        listener_function("removed", vec![trace(2)]),
                        listener_function("fresh", vec![trace(3)])
                    ]),
                    None,
                );
                let mut machine = Machine::new(&program).unwrap();
                install_form(&mut machine);
                install_host_listener(&mut machine, 0, false);
                install_host_listener(&mut machine, 1, false);
                let old_registration = machine.host_listeners[1].3;
                invoke_listener_test_submit(&mut machine, physical);
                assert!(matches!(machine.instances[0].cells[0], Val::Num(1.0)));
                assert_ne!(machine.host_listeners[1].3, old_registration);
                invoke_listener_test_submit(&mut machine, physical);
                let expected = if replacement == 1 { 112.0 } else { 113.0 };
                assert!(matches!(machine.instances[0].cells[0], Val::Num(n) if n == expected));
                assert!(machine.submitting_forms.is_empty());
                assert!(machine.uncaught.is_empty());
            }
        }
    }

    fn element_registration(method: &str, function: usize) -> serde_json::Value {
        json!({"op": "expr", "value": {"op": "builtin", "name": method, "type": "void", "args": [
            {"op": "builtin", "name": "event.target", "type": "element", "args": [{"op": "local", "local": 0}]},
            {"op": "lit", "value": "submit"}, {"op": "closure", "function": function, "captures": [], "stable": true}
        ]}})
    }

    fn element_listener_function(name: &str, body: Vec<serde_json::Value>) -> serde_json::Value {
        let mut function = listener_function(name, body);
        function["params"] = json!([{"name": "event", "type": "event"}]);
        function
    }

    fn live_form_program(functions: serde_json::Value, checkpoint: Checkpoint) -> Program {
        let mut program = listener_program(functions, Some(2));
        program.schedule.checkpoint = checkpoint;
        program.components[0].template = serde_json::from_value(json!([{
            "kind": "element", "tag": "form", "attrs": [{"name": "id", "value": {"op": "lit", "value": "form"}}],
            "listeners": [{"event": "submit", "handler": 0}], "children": []
        }])).unwrap();
        program
    }

    fn install_live_form(machine: &mut Machine<'_>) -> u64 {
        machine.render().unwrap();
        for function in 0..machine.program.functions.len() {
            machine.stable_fns.insert(
                (Some(0), function),
                Val::Closure(Rc::new(Closure {
                    function,
                    captures: vec![],
                    instance: Some(0),
                    snapshot: None,
                })),
            );
        }
        element_by_id(&machine.last_tree, "form").unwrap()
    }

    fn install_element_listener(machine: &mut Machine<'_>, form: u64, function: usize) {
        let f = machine.stable_fns[&(Some(0), function)].clone();
        machine
            .builtin(
                "element.listen",
                vec![
                    Val::Element(js::Element(form)),
                    Val::Str("submit".into()),
                    f,
                ],
                &[],
                &Type::Void,
            )
            .unwrap();
    }

    #[test]
    fn physical_capture_added_form_listener_preserves_callback_checkpoint_policy() {
        for checkpoint in [Checkpoint::Dispatch, Checkpoint::Listener] {
            let mut program = live_form_program(
                json!([
                    element_listener_function(
                        "capture",
                        vec![trace(1), element_registration("element.listen", 1)]
                    ),
                    element_listener_function("added form listener", vec![trace(3)]),
                    listener_function("queued job", vec![trace(9)])
                ]),
                checkpoint,
            );
            program.components[0].handlers[0].body.insert(1, serde_json::from_value(json!({
                "op": "expr", "value": {"op": "builtin", "name": "microtask.queue", "type": "void", "args": [
                    {"op": "closure", "function": 2, "captures": [], "stable": true}
                ]}
            })).unwrap());
            let mut machine = Machine::new(&program).unwrap();
            let form = install_live_form(&mut machine);
            install_host_listener(&mut machine, 0, true);
            let mut run = Run::default();
            machine.submit_form(form, None, &mut run).unwrap();
            let expected = if checkpoint == Checkpoint::Dispatch {
                1239.0
            } else {
                1293.0
            };
            assert!(matches!(machine.instances[0].cells[0], Val::Num(n) if n == expected));
            assert!(run.error.is_none());
            assert!(machine.submitting_forms.is_empty());
        }
    }

    #[test]
    fn physical_form_removed_and_readded_listeners_wait_for_next_target_invocation() {
        for checkpoint in [Checkpoint::Dispatch, Checkpoint::Listener] {
            for replacement in [1, 2] {
                let program = live_form_program(
                    json!([
                        element_listener_function(
                            "first",
                            vec![
                                trace(3),
                                json!({"op": "if", "test": {
                        "op": "not", "arg": {"op": "cell", "cell": 1}
                    }, "then": [
                        {"op": "set", "cell": 1, "value": {"op": "lit", "value": true}},
                        element_registration("element.unlisten", 1), element_registration("element.listen", replacement)
                    ], "else": []})
                            ]
                        ),
                        element_listener_function("removed", vec![trace(4)]),
                        element_listener_function("fresh", vec![trace(5)])
                    ]),
                    checkpoint,
                );
                let mut machine = Machine::new(&program).unwrap();
                let form = install_live_form(&mut machine);
                install_element_listener(&mut machine, form, 0);
                install_element_listener(&mut machine, form, 1);
                let mut run = Run::default();
                machine.submit_form(form, None, &mut run).unwrap();
                assert!(matches!(machine.instances[0].cells[0], Val::Num(23.0)));
                machine.submit_form(form, None, &mut run).unwrap();
                let expected = if replacement == 1 { 23234.0 } else { 23235.0 };
                assert!(matches!(machine.instances[0].cells[0], Val::Num(n) if n == expected));
                assert!(run.error.is_none());
                assert!(machine.submitting_forms.is_empty());
            }
        }
    }

    #[test]
    fn empty_physical_form_path_does_not_insert_an_element_checkpoint() {
        for checkpoint in [Checkpoint::Dispatch, Checkpoint::Listener] {
            let mut program = live_form_program(
                json!([listener_function("queued job", vec![trace(9)])]),
                checkpoint,
            );
            let Node::Element { listeners, .. } = &mut program.components[0].template[0] else {
                unreachable!()
            };
            listeners.clear();
            let mut machine = Machine::new(&program).unwrap();
            let form = install_live_form(&mut machine);
            let f = machine.stable_fns[&(Some(0), 0)].clone();
            machine
                .builtin("microtask.queue", vec![f], &[], &Type::Void)
                .unwrap();
            let tasks = machine.tasks_run;
            let mut run = Run::default();
            assert!(
                machine
                    .dispatch_submit_path(form, &mut run)
                    .unwrap()
                    .is_some()
            );
            assert_eq!(machine.tasks_run, tasks);
            assert!(matches!(machine.instances[0].cells[0], Val::Num(0.0)));
            assert!(!machine.microtasks.is_empty());
            machine.checkpoint();
            assert!(matches!(machine.instances[0].cells[0], Val::Num(9.0)));
            assert!(run.error.is_none());
        }
    }

    fn propagation_program(checkpoint: Checkpoint, stop: &str) -> Program {
        let event_op = |name: &str| {
            json!({"op": "expr", "value": {
                "op": "builtin", "name": name, "type": "void", "args": [{"op": "local", "local": 0}]
            }})
        };
        live_form_program(
            json!([
                element_listener_function(
                    "capture",
                    vec![
                        trace(1),
                        json!({
                            "op": "expr", "value": {"op": "builtin", "name": "microtask.queue", "type": "void", "args": [
                                {"op": "closure", "function": 1, "captures": [], "stable": true}
                            ]}
                        }),
                        event_op("event.preventDefault"),
                        event_op(stop),
                        trace(2)
                    ]
                ),
                listener_function("queued job", vec![trace(9)]),
                element_listener_function("suppressed document and form listener", vec![trace(3)]),
                element_listener_function("suppressed window listener", vec![trace(4)]),
                element_listener_function("same-phase capture continuation", vec![trace(3)])
            ]),
            checkpoint,
        )
    }

    fn install_propagation_listeners(machine: &mut Machine<'_>, form: u64, capture: bool) {
        if capture {
            install_host_listener(machine, 0, true);
            install_host_listener(machine, 4, true);
        }
        install_host_listener(machine, 2, false);
        install_element_listener(machine, form, 2);
        let f = machine.stable_fns[&(Some(0), 3)].clone();
        machine
            .builtin(
                "window.listen",
                vec![Val::Str("submit".into()), f],
                &[],
                &Type::Void,
            )
            .unwrap();
    }

    #[test]
    fn physical_capture_stops_do_not_create_suppressed_tasks_or_checkpoints() {
        for checkpoint in [Checkpoint::Dispatch, Checkpoint::Listener] {
            for stop in ["event.stopPropagation", "event.stopImmediatePropagation"] {
                let program = propagation_program(checkpoint, stop);
                let mut machine = Machine::new(&program).unwrap();
                let form = install_live_form(&mut machine);
                install_propagation_listeners(&mut machine, form, true);
                let tasks = machine.tasks_run;
                let mut run = Run::default();
                machine.submit_form(form, None, &mut run).unwrap();
                let immediate = stop == "event.stopImmediatePropagation";
                assert_eq!(
                    machine.tasks_run - tasks,
                    if immediate { 1 } else { 2 },
                    "only allowed same-phase capture callbacks are tasks"
                );
                let expected = if immediate { 129.0 } else { 1293.0 };
                assert!(
                    matches!(machine.instances[0].cells[0], Val::Num(n) if n == expected),
                    "queued job follows first capture callback; later phases never run"
                );
                assert!(machine.microtasks.is_empty());
                assert!(machine.submitting_forms.is_empty());
                assert!(run.error.is_none());
            }
        }
    }

    #[test]
    fn nested_capture_stops_preserve_same_phase_callbacks_without_a_checkpoint() {
        for checkpoint in [Checkpoint::Dispatch, Checkpoint::Listener] {
            for stop in ["event.stopPropagation", "event.stopImmediatePropagation"] {
                let program = propagation_program(checkpoint, stop);
                let mut machine = Machine::new(&program).unwrap();
                let form = install_live_form(&mut machine);
                install_propagation_listeners(&mut machine, form, true);
                let tasks = machine.tasks_run;
                machine.request_submit(form).unwrap();
                let immediate = stop == "event.stopImmediatePropagation";
                let synchronous = if immediate { 12.0 } else { 123.0 };
                assert!(matches!(machine.instances[0].cells[0], Val::Num(n) if n == synchronous));
                assert_eq!(
                    machine.tasks_run, tasks,
                    "requestSubmit inserts no task/checkpoint"
                );
                assert!(!machine.microtasks.is_empty());
                assert!(machine.submitting_forms.is_empty());
                assert!(!machine.in_event && !machine.dispatching);
                assert!(machine.event.is_none());
                machine.checkpoint();
                let expected = if immediate { 129.0 } else { 1239.0 };
                assert!(matches!(machine.instances[0].cells[0], Val::Num(n) if n == expected));
                assert!(machine.uncaught.is_empty());
            }
        }
    }

    #[test]
    fn stopped_element_capture_never_reenters_the_target_or_ancestor_bubble_phase() {
        // Exercise internal element-capture invocation boundaries without
        // extending frontend admission of capture registrations.
        for checkpoint in [Checkpoint::Dispatch, Checkpoint::Listener] {
            for stop in ["event.stopPropagation", "event.stopImmediatePropagation"] {
                for at_target in [false, true] {
                    for physical in [false, true] {
                        let mut program = propagation_program(checkpoint, stop);
                        let capture = json!({"op": "attrs", "items": [{"name": "onsubmitcapture", "value": {
                            "op": "closure", "function": 0, "captures": [], "stable": true
                        }}]});
                        let mut form =
                            serde_json::to_value(&program.components[0].template[0]).unwrap();
                        if at_target {
                            form["spread"] = capture;
                        } else {
                            form = json!({"kind": "element", "tag": "div", "spread": capture,
                                "listeners": [{"event": "submit", "handler": 0}], "children": [form]});
                        }
                        program.components[0].template =
                            vec![serde_json::from_value(form).unwrap()];
                        let mut machine = Machine::new(&program).unwrap();
                        let form = install_live_form(&mut machine);
                        install_propagation_listeners(&mut machine, form, false);
                        let tasks = machine.tasks_run;
                        let mut run = Run::default();
                        if physical {
                            machine.submit_form(form, None, &mut run).unwrap();
                            assert_eq!(machine.tasks_run - tasks, 1);
                        } else {
                            machine.request_submit(form).unwrap();
                            assert_eq!(machine.tasks_run, tasks);
                            assert!(matches!(machine.instances[0].cells[0], Val::Num(12.0)));
                            machine.checkpoint();
                        }
                        assert!(matches!(machine.instances[0].cells[0], Val::Num(129.0)));
                        assert!(machine.submitting_forms.is_empty());
                        assert!(run.error.is_none());
                        assert!(machine.uncaught.is_empty());
                    }
                }
            }
        }
    }

    #[test]
    fn repeated_nested_submit_keeps_listeners_tree_and_outer_event_state() {
        let mut program: Program = serde_json::from_value(json!({
            "schema": 5,
            "meta": {"title": "nested submit", "sourceHash": "test", "frontend": {}},
            "capabilities": [], "styles": {"css": ""}, "root": 0,
            "functions": [{
                "name": "capture", "component": 0, "params": [], "result": "void",
                "body": [{"op": "set", "cell": 1, "value": {
                    "op": "builtin", "name": "element.isConnected", "type": "boolean",
                    "args": [{"op": "builtin", "name": "event.target", "type": "element", "args": [{"op": "event"}]}]
                }}]
            }],
            "components": [{
                "name": "Test", "template": [],
                "cells": [
                    {"name": "calls", "type": "number", "init": {"op": "lit", "value": 0}},
                    {"name": "visible", "type": "boolean", "init": {"op": "lit", "value": false}}
                ],
                "handlers": [{"event": "submit", "body": [
                    {"op": "set", "cell": 0, "value": {"op": "add", "left": {"op": "cell", "cell": 0}, "right": {"op": "lit", "value": 1}}},
                    {"op": "expr", "value": {"op": "builtin", "name": "event.preventDefault", "type": "void", "args": [{"op": "event"}]}}
                ]}]
            }]
        })).unwrap();
        program.schedule.flush = Flush::EventMicrotask;
        let mut machine = Machine::new(&program).unwrap();
        machine.last_tree = vec![VNode::Element {
            tag: "form".into(),
            attrs: BTreeMap::new(),
            value: None,
            checked: None,
            id: 1,
            listeners: vec![(EventKind::Submit, 0)],
            children: vec![],
        }];
        machine.listeners.push(ListenerRef {
            instance: 0,
            handler: 0,
            args: vec![],
            closure: None,
        });
        machine.known_forms.insert(1);
        machine.flush_pending = true;
        machine.default_tasks.push_back(Micro::Flush);
        machine.capture_listeners.push((
            false,
            EventKind::Submit,
            Val::Closure(Rc::new(Closure {
                function: 0,
                captures: vec![],
                instance: Some(0),
                snapshot: None,
            })),
            0,
        ));
        let outer = js::Event::new(js::EventData {
            kind: "click".into(),
            ..Default::default()
        });
        machine.event = Some(outer.clone());
        machine.payload = Some(Val::Str("outer".into()));
        for _ in 0..2 {
            machine.request_submit(1).unwrap();
            assert!(machine.submitting_forms.is_empty());
            assert!(!machine.dispatching && !machine.in_event);
            assert_eq!(
                machine.event.as_ref().unwrap().data().kind.to_rust(),
                "click"
            );
            assert!(matches!(&machine.payload, Some(Val::Str(s)) if s.to_rust() == "outer"));
        }
        assert!(matches!(machine.instances[0].cells[0], Val::Num(2.0)));
        assert!(matches!(machine.instances[0].cells[1], Val::Bool(true)));
        assert_eq!(machine.listeners.len(), 1);
        assert!(machine.default_tasks.is_empty());
        assert!(machine.microtasks.iter().any(|m| matches!(m, Micro::Flush)));
        assert!(chain_nodes(&machine.last_tree, 1).is_some());
        machine.submitting_forms.insert(1);
        machine.request_submit(1).unwrap();
        assert!(matches!(machine.instances[0].cells[0], Val::Num(2.0)));
        machine.submitting_forms.remove(&1);
        // An ordinary removed form remains a no-op receiver.
        machine.render().unwrap();
        machine.request_submit(1).unwrap();
        assert!(matches!(machine.instances[0].cells[0], Val::Num(2.0)));
        assert!(!machine.detached_shadowed_forms.contains(&1));
        assert!(matches!(machine.host.console.last(), Some(("warn", text))
            if text.to_rust() == js::forms::DISCONNECTED_SUBMISSION_WARNING));
        // Removal records shadowing from the old subtree, even with an
        // uncertain explicit owner, and includes the legacy image lookup.
        for (form, tag, attribute) in [(2, "input", "name"), (4, "img", "id")] {
            machine.known_forms.insert(form);
            machine.last_tree = vec![VNode::Element {
                tag: "form".into(),
                attrs: BTreeMap::new(),
                value: None,
                checked: None,
                id: form,
                listeners: vec![],
                children: vec![VNode::Element {
                    tag: tag.into(),
                    attrs: BTreeMap::from([
                        (attribute.into(), "requestSubmit".into()),
                        ("form".into(), "other-form".into()),
                    ]),
                    value: None,
                    checked: None,
                    id: form + 1,
                    listeners: vec![],
                    children: vec![],
                }],
            }];
            machine.render().unwrap();
            assert!(machine.detached_shadowed_forms.contains(&form));
            let error = machine.request_submit(form).unwrap_err();
            assert_eq!(error.name.to_rust(), "RunicUnsupportedError");
            assert!(error.to_string().contains("named-property shadowing"));
            assert!(machine.submitting_forms.is_empty());
        }
    }
}

#[cfg(test)]
mod union_tests {
    use super::*;

    /// Functions over `number | string | {a}`: 0 describes its argument by
    /// member, 1 downcasts it to a string, 2 is `typeof`.
    fn program() -> Program {
        let u = json!({"union": ["number", "string", {"record": 0}]});
        let x = json!({"op": "local", "local": 0});
        serde_json::from_value(json!({
            "schema": 5,
            "meta": {"title": "unions", "sourceHash": "0".repeat(64), "frontend": {}},
            "capabilities": [], "styles": {"css": ""}, "root": 0,
            "records": [{"name": "Plain", "fields": [{"name": "a", "type": "number"}]}],
            "functions": [
                {"name": "describe", "params": [{"name": "x", "type": u}],
                 "locals": [{"name": "n", "type": "number"}, {"name": "s", "type": "string"}],
                 "result": "string", "body": [{"op": "return", "value": {
                    "op": "match-union", "value": x, "cases": [
                        {"type": "number", "local": 1, "body": {"op": "to-string", "arg": {"op": "local", "local": 1}}},
                        {"type": "string", "local": 2, "body": {"op": "local", "local": 2}}
                    ], "else": {"op": "lit", "value": "record"}}}]},
                {"name": "string", "params": [{"name": "x", "type": u}], "result": "string",
                 "body": [{"op": "return", "value": {"op": "downcast", "value": x, "type": "string"}}]},
                {"name": "kind", "params": [{"name": "x", "type": u}], "result": "string",
                 "body": [{"op": "return", "value": {"op": "typeof", "arg": x}}]}
            ],
            "components": [{"name": "Test", "template": []}]
        }))
        .unwrap()
    }

    fn record() -> Val {
        Val::Record(JsRef::new(RecordData::new(0, vec![Val::Num(1.0)], false)))
    }

    #[test]
    fn members_dispatch_and_downcasts_check_them() {
        let program = program();
        crate::validate::validate(&program).unwrap();
        let mut m = Machine::new(&program).unwrap();
        let s = |v: Val| match v {
            Val::Str(s) => s.to_string(),
            other => panic!("{other:?}"),
        };
        assert_eq!(s(m.call(0, vec![], vec![Val::Num(2.0)]).unwrap()), "2");
        assert_eq!(
            s(m.call(0, vec![], vec![Val::Str("a".into())]).unwrap()),
            "a"
        );
        assert_eq!(s(m.call(0, vec![], vec![record()]).unwrap()), "record");
        assert_eq!(
            s(m.call(1, vec![], vec![Val::Str("b".into())]).unwrap()),
            "b"
        );
        let e = m.call(1, vec![], vec![Val::Num(2.0)]).unwrap_err();
        assert_eq!(e.name.to_string(), "TypeError");
        assert_eq!(
            e.message.to_string(),
            "A number where the static type expects string"
        );
        assert_eq!(s(m.call(2, vec![], vec![Val::Num(2.0)]).unwrap()), "number");
        assert_eq!(s(m.call(2, vec![], vec![record()]).unwrap()), "object");
    }
}
