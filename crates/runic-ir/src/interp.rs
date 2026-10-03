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
use std::collections::BTreeMap;
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

struct Frame {
    locals: Vec<Rc<RefCell<Val>>>,
}

impl Frame {
    fn new(n: usize) -> Self {
        Frame {
            locals: (0..n)
                .map(|_| Rc::new(RefCell::new(Val::Undefined)))
                .collect(),
        }
    }
    fn get(&self, i: usize) -> Val {
        self.locals[i].borrow().clone()
    }
    fn set(&self, i: usize, v: Val) {
        *self.locals[i].borrow_mut() = v;
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
                children,
                ..
            } => {
                let mut o = Map::new();
                o.insert("tag".into(), json!(tag));
                o.insert("attrs".into(), json!(attrs));
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

pub struct Machine<'p> {
    pub program: &'p Program,
    component: usize,
    pub cells: Vec<Val>,
    snapshot: Vec<Val>,
    payload: Option<JsString>,
}

fn throw_diag(t: Throw) -> Diagnostic {
    Diagnostic::new("E_THROW", t.to_string(), None)
}

impl<'p> Machine<'p> {
    pub fn new(program: &'p Program) -> Result<Self> {
        let mut m = Machine {
            program,
            component: program.root,
            cells: vec![],
            snapshot: vec![],
            payload: None,
        };
        let comp = &program.components[program.root];
        for cell in &comp.cells {
            let frame = Frame::new(0);
            let v = m.eval(&cell.init, &frame).map_err(throw_diag)?;
            check_domain(cell, &v)?;
            m.cells.push(v);
            m.snapshot = m.cells.clone();
        }
        Ok(m)
    }

    fn comp(&self) -> &'p Component {
        &self.program.components[self.component]
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
            } => self.cells[*cell].clone(),
            Cell {
                cell,
                read: Read::Snapshot,
            } => self.snapshot[*cell].clone(),
            Local { local } => f.get(*local),
            Payload => Val::Str(self.payload.clone().expect("payload context")),
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
            Closure { function, captures } => Val::Closure(Rc::new(self::Closure {
                function: *function,
                captures: captures.iter().map(|&c| Rc::clone(&f.locals[c])).collect(),
            })),
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
        let mut frame = frame;
        for (i, c) in captures.into_iter().enumerate() {
            frame.locals[i] = c;
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
        self.call(c.function, c.captures.clone(), args)
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
                Val::Record(r) => r.borrow_mut().fields[*field] = v,
                other => panic!("validated record, found {other:?}"),
            },
            Place::Index { array, index } => {
                let a = self.eval(array, f)?.array();
                let i = self.eval(index, f)?.num();
                js::array_ops::set(&a, i, v)?;
            }
        }
        Ok(())
    }

    fn set_cell(&mut self, cell: usize, v: Val) -> Res<()> {
        if let Err(d) = check_domain(&self.comp().cells[cell], &v) {
            return Err(Throw::new("RunicDomainError", d.message));
        }
        self.cells[cell] = v;
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
                let _ = &f.locals[*local];
                f.set(*local, v);
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
                    f.set(*local, item);
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
            Val::Undefined | Val::Closure(_) => return None,
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

    pub fn render(&mut self) -> Result<Vec<VNode>> {
        let mut out = vec![];
        let template = &self.comp().template;
        for n in template {
            self.render_node(n, &mut out).map_err(throw_diag)?;
        }
        Ok(normalize(out))
    }

    fn render_node(&mut self, n: &Node, out: &mut Vec<VNode>) -> Res<()> {
        let frame = Frame::new(0);
        match n {
            Node::Text { parts, .. } => {
                let mut text = String::new();
                for p in parts {
                    text.push_str(&self.eval(p, &frame)?.string().to_rust());
                }
                out.push(VNode::Text(text));
            }
            Node::If {
                test,
                then,
                otherwise,
                ..
            } => {
                let body = if self.eval(test, &frame)?.boolean() {
                    then
                } else {
                    otherwise
                };
                for c in body {
                    self.render_node(c, out)?;
                }
            }
            Node::Element {
                tag,
                attrs,
                props,
                listeners,
                children,
                ..
            } => {
                let mut map = BTreeMap::new();
                for a in attrs {
                    match self.eval(&a.value, &frame)? {
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
                for p in props {
                    if p.name == "value" {
                        value = Some(self.eval(&p.value, &frame)?.string().to_rust());
                    }
                }
                let mut kids = vec![];
                for c in children {
                    self.render_node(c, &mut kids)?;
                }
                out.push(VNode::Element {
                    tag: tag.clone(),
                    attrs: map,
                    value,
                    listeners: listeners.iter().map(|l| (l.event, l.handler)).collect(),
                    children: normalize(kids),
                });
            }
        }
        Ok(())
    }

    pub fn snapshot(&mut self) -> Json {
        let cells: Vec<Json> = self.cells.iter().map(cell_json).collect();
        let dom = match self.render() {
            Ok(d) => Json::Array(d.iter().map(VNode::to_json).collect()),
            Err(e) => json!({ "error": e.to_string() }),
        };
        json!({ "cells": cells, "dom": dom })
    }

    /// Run handler `h`. Writes made before an exception persist (as in
    /// JavaScript); text-domain violations reject the whole handler.
    pub fn run(&mut self, h: usize, payload: Option<&str>) -> Result<Vec<bool>> {
        let handler = &self.comp().handlers[h];
        let before = self.cells.clone();
        self.snapshot = self.cells.clone();
        self.payload = payload.map(JsString::from);
        let frame = Frame::new(handler.locals.len());
        let result = self.exec_block(&handler.body, &frame);
        self.payload = None;
        if let Err(t) = &result {
            if t.name.to_rust() == "RunicDomainError" {
                self.cells = before;
                return Err(Diagnostic::new("E_TEXT_PAYLOAD", t.message.to_rust(), None));
            }
        }
        let changed = self
            .cells
            .iter()
            .zip(&before)
            .map(|(a, b)| !a.same(b))
            .collect();
        match result {
            Ok(_) => Ok(changed),
            Err(t) => Err(Diagnostic::new(
                "E_THROW",
                t.to_string(),
                handler.source.as_ref(),
            )),
        }
    }

    /// Fire `event` at the element with `id`. Returns `Ok(false)` when the DOM
    /// rules or a missing listener mean no handler runs.
    pub fn fire(&mut self, id: &str, event: EventKind, payload: Option<&str>) -> Result<bool> {
        let tree = self.render()?;
        let Some(VNode::Element {
            attrs, listeners, ..
        }) = find(&tree, id)
        else {
            return Err(Diagnostic::new(
                "E_TARGET",
                format!("No element #{id} is rendered"),
                None,
            ));
        };
        if attrs.contains_key("disabled")
            || (event == EventKind::Input && attrs.contains_key("readonly"))
        {
            return Ok(false);
        }
        let Some(&(_, h)) = listeners.iter().find(|(k, _)| *k == event) else {
            return Ok(false);
        };
        self.run(h, payload)?;
        Ok(true)
    }
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
