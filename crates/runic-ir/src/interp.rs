//! Reference interpreter: the executable definition of schema 4 semantics.
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
    pub fields: Vec<Val>,
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
            (Val::Element(a), Val::Element(b)) => a == b,
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
            Val::Closure(_) => JsString::from("function"),
            Val::Element(e) => e.to_js_string(),
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
            _ => f64::NAN,
        }
    }
}

impl js::Own for Val {
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
    fn own_fields(&mut self) {
        use js::Own;
        for f in self.fields.iter_mut() {
            *f = f.clone().own();
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
            Val::Closure(_) => "function",
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
            Val::Element(e) => e.map_key(),
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
    /// The value each prop cell last received from the parent.
    passed: Vec<Option<Val>>,
    /// Two-way binding setters of prop cells.
    binds: Vec<Option<Val>>,
    /// Content the parent provides for each declared slot.
    slots: Vec<Option<Provided<'p>>>,
    alive: bool,
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
struct ListenerRef {
    instance: usize,
    handler: usize,
    args: Vec<Val>,
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
    /// The flush job (see [`Schedule`]).
    Flush,
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
    children: HashMap<InstKey, usize>,
    /// Listeners of the last render, indexed by `VNode` listener ids.
    listeners: Vec<ListenerRef>,
    /// Child instances in tree order (last render).
    order: Vec<usize>,
    /// Stable ids of rendered elements with refs, by identity.
    element_ids: HashMap<(InstKey, usize), u64>,
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
    /// Heap mutation epochs at the last flush; mutations of tracked heap
    /// values queue a flush like cell writes.
    epochs: (u64, u64),
    tracks_deep: bool,
    tracks_owned: bool,
    /// Exceptions thrown by microtasks and default tasks (reported, as a
    /// browser reports uncaught errors, after the task).
    uncaught: Vec<Throw>,
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
            refs: HashMap::new(),
            current: 0,
            payload: None,
            children: HashMap::new(),
            listeners: vec![],
            order: vec![],
            snap: None,
            microtasks: VecDeque::new(),
            default_tasks: VecDeque::new(),
            flush_pending: false,
            in_event: false,
            epochs: (js::mutation_epoch(), js::owned_epoch()),
            tracks_deep: cells_tracked(program, Tracking::Deep),
            tracks_owned: cells_tracked(program, Tracking::Proxied),
            uncaught: vec![],
        };
        for g in &program.globals {
            let v = m.eval(&g.init, &Frame::new(0)).map_err(throw_diag)?;
            m.globals.push(v);
        }
        m.create(program.root, &[]).map_err(throw_diag)?;
        Ok(m)
    }

    /// Create an instance of `component` with the props passed by its parent
    /// (`(cell, value, bind)`); returns its id.
    fn create(&mut self, component: usize, props: &[(usize, Val, Option<Val>)]) -> Res<usize> {
        let comp = &self.program.components[component];
        let id = self.instances.len();
        let n = comp.cells.len();
        self.instances.push(Instance {
            component,
            cells: Vec::with_capacity(n),
            snapshot: Rc::new(vec![]),
            passed: vec![None; n],
            binds: vec![None; n],
            slots: vec![None; comp.slots.len()],
            alive: true,
        });
        let saved = std::mem::replace(&mut self.current, id);
        let result = (|| -> Res<()> {
            for (i, cell) in comp.cells.iter().enumerate() {
                let passed = props.iter().find(|(c, _, _)| *c == i);
                let v = match passed {
                    Some((_, v, _)) => v.clone(),
                    // Initial proxied state is proxied (props are passed as is).
                    None if cell.tracking == Tracking::Proxied && cell.prop.is_none() => {
                        js::Own::own(self.eval(&cell.init, &Frame::new(0))?)
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
            }
            Ok(())
        })();
        self.current = saved;
        result.map(|_| id)
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
            } => self.inst().cells[*cell].clone(),
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
            Not { arg } => Val::Bool(!self.eval(arg, f)?.boolean()),
            Neg { arg } => Val::Num(-self.eval(arg, f)?.num()),
            BitNot { arg } => Val::Num(js::bit_not(self.eval(arg, f)?.num())),
            ToString { arg } => Val::Str(js::ToJsString::to_js_string(&self.eval(arg, f)?)),
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
                let values = fields
                    .iter()
                    .map(|x| self.eval(x, f))
                    .collect::<Res<Vec<_>>>()?;
                Val::Record(JsRef::new(RecordData {
                    record: *record,
                    fields: values,
                }))
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
                Val::Record(r) => r.borrow().fields[*field].clone(),
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
            Unwrap { value } => match self.eval(value, f)? {
                Val::Undefined => {
                    return Err(Throw::type_error("Cannot read properties of undefined"));
                }
                Val::Null => return Err(Throw::type_error("Cannot read properties of null")),
                v => v,
            },
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
            Closure { function, captures } => {
                let target = &self.program.functions[*function];
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
                Val::Closure(Rc::new(self::Closure {
                    function: *function,
                    captures,
                    instance: target.component.map(|_| self.current),
                    snapshot: target.component.map(|_| self.current_snapshot()),
                }))
            }
            Builtin { name, args, ty } => {
                let values = args
                    .iter()
                    .map(|a| self.eval(a, f))
                    .collect::<Res<Vec<_>>>()?;
                let types: Vec<Type> = args.iter().map(|a| self.type_of(a, f)).collect();
                self.builtin(name, values, &types, ty)?
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
                    let v = js::own_into(&r, v);
                    r.borrow_mut().fields[*field] = v
                }
                other => panic!("validated record, found {other:?}"),
            },
            Place::Index { array, index } => {
                let a = self.eval(array, f)?.array();
                let i = self.eval(index, f)?.num();
                let v = js::own_into(&a, v);
                js::array_ops::set(&a, i, v)?;
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
            _ => v,
        };
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
                                    Val::Record(JsRef::new(RecordData {
                                        record,
                                        fields: vec![Val::Str(t.name), Val::Str(t.message)],
                                    })),
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
        // Items inserted into a proxied array become proxies.
        let inserted = match name {
            "array.push" | "array.unshift" => 1..usize::MAX,
            "array.fill" => 1..2,
            "array.splice" => 3..usize::MAX,
            _ => 0..0,
        };
        let a: Vec<Val> = match (a.first(), inserted.is_empty()) {
            (Some(Val::Array(r)), false) if r.is_owned() => a
                .into_iter()
                .enumerate()
                .map(|(i, v)| {
                    if inserted.contains(&i) {
                        js::Own::own(v)
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
            ("Map", "new") => Val::Map(arr::map_new::<Val, Val>(vec![])),
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
            ("microtask", "queue") => {
                self.queue_micro(a[0].clone());
                Val::Undefined
            }
            ("clock", "now") => Val::Num(self.now),
            ("clock", "date") => Val::Num(CLOCK_ORIGIN + self.now),
            // Focus has no interpreter observable (the snapshot has no focus).
            ("element", "focus" | "blur") => Val::Undefined,
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

    fn to_json(&self, v: &Val) -> Option<js::json::Json> {
        use js::json::Json as J;
        Some(match v {
            Val::Undefined | Val::Closure(_) | Val::Element(_) => return None,
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
                Val::Record(JsRef::new(RecordData { record: *r, fields }))
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
                Val::Record(JsRef::new(RecordData {
                    record: r.record,
                    fields: r.fields.iter().map(|x| self.clone_deep(x)).collect(),
                }))
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
        self.listeners.clear();
        self.order.clear();
        let mut visited = HashSet::new();
        let mut out = vec![];
        let previous = std::mem::take(&mut self.refs);
        let result = self.render_instance(0, &mut out, &mut visited);
        // Refs of elements that are no longer rendered become null.
        for ((inst, cell), id) in previous {
            if !self.refs.contains_key(&(inst, cell))
                && matches!(self.instances[inst].cells[cell], Val::Element(e) if e.0 == id)
            {
                self.instances[inst].cells[cell] = Val::Null;
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
        Ok(normalize(out))
    }

    fn render_instance(
        &mut self,
        id: usize,
        out: &mut Vec<VNode>,
        visited: &mut HashSet<usize>,
    ) -> Res<()> {
        let saved = std::mem::replace(&mut self.current, id);
        let comp = self.comp();
        let frame = Frame::new(comp.template_locals.len());
        let mut path = vec![];
        let r = comp
            .template
            .iter()
            .try_for_each(|n| self.render_node(n, &frame, &mut path, out, visited));
        self.current = saved;
        r
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
                ..
            } => {
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
                    path.push(k);
                    for c in body {
                        self.render_node(c, frame, path, out, visited)?;
                    }
                    path.pop();
                }
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
                        let child = self.current;
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
                let provided: Vec<Option<Provided<'p>>> = child
                    .slots
                    .iter()
                    .map(|d| {
                        slots.iter().find(|s| s.name == d.name).map(|def| Provided {
                            parent: self.current,
                            def,
                            values: values.clone(),
                        })
                    })
                    .collect();
                let id = match self.children.get(&key) {
                    Some(&id) => {
                        let inst = &mut self.instances[id];
                        for (cell, v, b) in args {
                            let changed = match &inst.passed[cell] {
                                Some(old) => !old.same(&v),
                                None => true,
                            };
                            if changed {
                                inst.passed[cell] = Some(v.clone());
                                inst.cells[cell] = v.clone();
                                Rc::make_mut(&mut inst.snapshot)[cell] = v;
                            }
                            inst.binds[cell] = b;
                        }
                        id
                    }
                    None => {
                        let id = self.create(*component, &args)?;
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
                ..
            } => {
                if let Some(cell) = reference {
                    let key = (
                        InstKey {
                            parent: self.current,
                            node: n as *const Node as usize,
                            path: path.clone(),
                            via: self.via.clone(),
                        },
                        0,
                    );
                    let next = self.element_ids.len() as u64 + 1;
                    let id = *self.element_ids.entry(key).or_insert(next);
                    let current = self.current;
                    self.instances[current].cells[*cell] = Val::Element(js::Element(id));
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
                let mut value = None;
                let mut checked = None;
                for p in props {
                    match p.name.as_str() {
                        "value" => value = Some(self.eval(&p.value, frame)?.string().to_rust()),
                        "checked" => {
                            checked = Some(self.eval(&p.value, frame)?.boolean());
                            // A checkbox's value property defaults to "on".
                            value = Some(map.get("value").cloned().unwrap_or_else(|| "on".into()));
                        }
                        _ => {}
                    }
                }
                let mut refs = vec![];
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
                    });
                }
                let mut kids = vec![];
                for c in children {
                    self.render_node(c, frame, path, &mut kids, visited)?;
                }
                out.push(VNode::Element {
                    tag: tag.clone(),
                    attrs: map,
                    value,
                    checked,
                    listeners: refs,
                    children: normalize(kids),
                });
            }
        }
        Ok(())
    }

    /// Cells of the root instance and the DOM; other live instances follow in
    /// tree order under `instances` (omitted when there are none).
    pub fn snapshot(&mut self) -> Json {
        let dom = match self.render() {
            Ok(d) => Json::Array(d.iter().map(VNode::to_json).collect()),
            Err(e) => json!({ "error": e.to_string() }),
        };
        let cells: Vec<Json> = self.instances[0].cells.iter().map(cell_json).collect();
        let mut state = json!({ "cells": cells, "dom": dom });
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
        self.in_event = event;
        let result = body(self);
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
        let uncaught = std::mem::take(&mut self.uncaught);
        match (result, uncaught.into_iter().next()) {
            (Err(t), _) | (Ok(()), Some(t)) => {
                Err(Diagnostic::new("E_THROW", t.to_string(), source))
            }
            (Ok(()), None) => Ok(()),
        }
    }

    /// Queue the flush job if none is pending.
    fn queue_flush(&mut self) {
        if self.flush_pending {
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
        self.note_mutations();
        self.microtasks.push_back(Micro::Call(callback));
    }

    /// Run microtasks until none are left.
    fn checkpoint(&mut self) {
        self.note_mutations();
        while let Some(job) = self.microtasks.pop_front() {
            self.run_micro(job);
            self.note_mutations();
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
        }
    }

    /// The flush job: commit the state (render snapshots) and update the
    /// tree, which creates, updates and destroys instances.
    fn flush(&mut self) {
        self.flush_pending = false;
        for i in &mut self.instances {
            if i.alive {
                i.snapshot = Rc::new(i.cells.clone());
            }
        }
        if let Err(d) = self.render() {
            self.uncaught.push(Throw::new("Error", d.message));
        }
        self.epochs = (js::mutation_epoch(), js::owned_epoch());
    }

    /// Run handler `h` of instance `instance` with listener arguments (in
    /// the running task).
    fn run(&mut self, instance: usize, h: usize, args: Vec<Val>, payload: Option<Val>) -> Res<()> {
        let component = self.instances[instance].component;
        let handler = &self.program.components[component].handlers[h];
        self.payload = payload;
        let frame = Frame::new(handler.params.len() + handler.locals.len());
        for (i, a) in args.into_iter().enumerate() {
            frame.set(i, a);
        }
        let saved = std::mem::replace(&mut self.current, instance);
        let saved_snap = self.snap.take();
        let r = self.exec_block(&handler.body, &frame);
        self.current = saved;
        self.snap = saved_snap;
        self.payload = None;
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
        Ok(())
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

    pub fn fire(
        &mut self,
        target: Target<'_>,
        event: EventKind,
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
                Target::Nth(..) | Target::Path(_) => Ok(false),
            };
        };
        let nodes = path_nodes(&tree, &path);
        let target_node = *nodes.last().expect("element path");
        let VNode::Element {
            tag,
            attrs,
            checked,
            ..
        } = target_node
        else {
            unreachable!("paths end at elements")
        };
        let control = |n: &VNode| matches!(n, VNode::Element { tag, attrs, .. } if matches!(tag.as_str(), "button" | "input") && attrs.contains_key("disabled"));
        let blocked = match event {
            EventKind::Click => nodes.iter().any(|n| control(n)),
            EventKind::Input => attrs.contains_key("disabled") || attrs.contains_key("readonly"),
            EventKind::Change | EventKind::Keydown => attrs.contains_key("disabled"),
        };
        if blocked {
            return Ok(false);
        }
        let listeners_of = |n: &VNode, kind: EventKind| -> Option<usize> {
            match n {
                VNode::Element { listeners, .. } => {
                    listeners.iter().find(|(k, _)| *k == kind).map(|(_, l)| *l)
                }
                VNode::Text(_) => None,
            }
        };
        // (listener, payload, dispatch) in dispatch order: a checkbox's
        // `change` is a second event after `click` unless the framework
        // delivers it with the click.
        let mut queue: Vec<(usize, Option<Val>, usize)> = vec![];
        match event {
            EventKind::Click => {
                for n in nodes.iter().rev() {
                    if let Some(l) = listeners_of(n, EventKind::Click) {
                        queue.push((l, None, 0));
                    }
                }
                if let Some(c) = checked {
                    if let Some(l) = listeners_of(target_node, EventKind::Change) {
                        let dispatch = usize::from(!self.program.schedule.change_with_click);
                        queue.push((l, Some(Val::Bool(!c)), dispatch));
                    }
                }
            }
            EventKind::Input | EventKind::Change => {
                if let Some(l) = listeners_of(target_node, event) {
                    let payload = match event {
                        EventKind::Input => Val::Str(JsString::from(data.unwrap_or_default())),
                        _ => Val::Bool(data == Some("true")),
                    };
                    queue.push((l, Some(payload), 0));
                }
            }
            EventKind::Keydown => {
                for n in nodes.iter().rev() {
                    if let Some(l) = listeners_of(n, EventKind::Keydown) {
                        let key = Val::Str(JsString::from(data.unwrap_or_default()));
                        queue.push((l, Some(key), 0));
                    }
                }
            }
        }
        let activate = event == EventKind::Keydown
            && match (tag.as_str(), data) {
                ("button", Some("Enter" | " ")) => true,
                ("input", Some(" ")) => checked.is_some(),
                _ => false,
            };
        let id = attrs.get("id").cloned();
        let ran = !queue.is_empty();
        let refs: Vec<(ListenerRef, Option<Val>, usize)> = queue
            .into_iter()
            .map(|(l, p, d)| {
                let r = std::mem::replace(
                    &mut self.listeners[l],
                    ListenerRef {
                        instance: 0,
                        handler: 0,
                        args: vec![],
                    },
                );
                (r, p, d)
            })
            .collect();
        // One task per event, or per listener where each listener ends with a
        // microtask checkpoint; an exception does not stop later listeners.
        let per_listener = self.program.schedule.checkpoint == Checkpoint::Listener;
        let mut tasks: Vec<Vec<(ListenerRef, Option<Val>)>> = vec![];
        let mut last = None;
        for (r, p, d) in refs {
            if per_listener || last != Some(d) {
                tasks.push(vec![]);
            }
            last = Some(d);
            tasks.last_mut().expect("task").push((r, p));
        }
        let mut first_error = None;
        for listeners in tasks {
            let source = {
                let (r, _) = &listeners[0];
                let c = self.instances[r.instance].component;
                self.program.components[c].handlers[r.handler]
                    .source
                    .clone()
            };
            let result = self.task(source.as_ref(), true, |m| {
                let mut error = None;
                for (r, payload) in listeners {
                    if let Err(t) = m.run(r.instance, r.handler, r.args, payload) {
                        if t.name.to_rust() == "RunicDomainError" {
                            return Err(t);
                        }
                        error.get_or_insert(t);
                    }
                }
                error.map_or(Ok(()), Err)
            });
            if let Err(d) = result {
                first_error.get_or_insert(d);
            }
        }
        if let Some(d) = first_error {
            return Err(d);
        }
        if activate {
            // The activated element is found again after the keydown handlers.
            let again = match &id {
                Some(id) => Target::Id(id),
                None => Target::Path(&path),
            };
            if locate(&self.render()?, &again).is_some() {
                return Ok(self.fire(again, EventKind::Click, None)? || ran);
            }
        }
        Ok(ran)
    }
}

/// An event target: an element id (the first in tree order), the n-th
/// element (in tree order, modulo their number) listening for an event kind
/// (clicks also select checkboxes listening for `change`), or a child-index path.
#[derive(Clone, Copy, Debug)]
pub enum Target<'a> {
    Id(&'a str),
    Nth(EventKind, usize),
    Path(&'a [usize]),
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
        Target::Path(p) => {
            let nodes = path_nodes_checked(tree, p)?;
            matches!(nodes.last(), Some(VNode::Element { .. })).then(|| p.to_vec())
        }
        Target::Id(id) => walk(tree, &mut path, &mut |n, _| {
            matches!(n, VNode::Element { attrs, .. } if attrs.get("id").map(String::as_str) == Some(*id))
        })
        .then_some(path),
        Target::Nth(kind, k) => {
            let listens = |n: &VNode| match n {
                VNode::Element { listeners, .. } => listeners.iter().any(|(e, _)| {
                    *e == *kind || (*kind == EventKind::Click && *e == EventKind::Change)
                }),
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
pub fn cell_json(v: &Val) -> Json {
    match v {
        Val::Undefined => Json::Null,
        Val::Null => Json::Null,
        Val::Bool(b) => json!(b),
        Val::Num(n) if n.is_finite() => json!(n),
        Val::Num(n) => json!(runic_js::number_to_string(*n)),
        Val::Str(s) => json!(s.to_rust()),
        Val::Array(a) => Json::Array(a.borrow().iter().map(cell_json).collect()),
        Val::Record(r) => Json::Array(r.borrow().fields.iter().map(cell_json).collect()),
        Val::Map(m) => Json::Array(
            m.borrow()
                .entries
                .values()
                .map(|(k, x)| json!([cell_json(k), cell_json(x)]))
                .collect(),
        ),
        Val::Set(s) => Json::Array(s.borrow().entries.values().map(cell_json).collect()),
        Val::Closure(_) => json!("function"),
        // Element ids differ between the interpreter and the native app.
        Val::Element(_) => json!("element"),
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
