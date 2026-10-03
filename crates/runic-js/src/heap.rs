//! Reference values (objects, arrays, maps, sets) with JavaScript identity,
//! the mutation epochs that drive "deep" cell tracking, and proxies of
//! proxied deep state (Svelte's `$state`).

use crate::{Element, JsString, Maybe};
use std::cell::{Cell, Ref, RefCell, RefMut};
use std::fmt;
use std::rc::Rc;

thread_local! {
    static VISITING: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
    static EPOCH: Cell<u64> = const { Cell::new(0) };
    static OWNED_EPOCH: Cell<u64> = const { Cell::new(0) };
}

/// Incremented by every mutable access to a heap value. A handler compares
/// the epoch before and after to decide whether deep-tracked cells may have
/// changed (docs/design/M2-VALUES.md).
pub fn mutation_epoch() -> u64 {
    EPOCH.with(Cell::get)
}

/// Incremented by mutable access through a proxy (see [`JsRef::proxy`]):
/// only those mutations make proxied cells dirty, as only writes through a
/// Svelte state proxy are reactive.
pub fn owned_epoch() -> u64 {
    OWNED_EPOCH.with(Cell::get)
}

struct Inner<T> {
    storage: Rc<RefCell<T>>,
    /// A proxy of deep state (as opposed to the raw value).
    owned: bool,
}

/// A shared, mutable heap value; equality is identity (`===`). A proxy has its
/// own identity but shares the storage of the value it wraps.
pub struct JsRef<T>(Rc<Inner<T>>);

impl<T> JsRef<T> {
    pub fn new(value: T) -> Self {
        JsRef(Rc::new(Inner {
            storage: Rc::new(RefCell::new(value)),
            owned: false,
        }))
    }
    pub fn borrow(&self) -> Ref<'_, T> {
        self.0.storage.borrow()
    }
    /// Mutable access; records a heap mutation.
    pub fn borrow_mut(&self) -> RefMut<'_, T> {
        EPOCH.with(|e| e.set(e.get() + 1));
        if self.0.owned {
            OWNED_EPOCH.with(|e| e.set(e.get() + 1));
        }
        self.0.storage.borrow_mut()
    }
    pub fn ptr_eq(a: &Self, b: &Self) -> bool {
        Rc::ptr_eq(&a.0, &b.0)
    }
    /// Stable identity for hashing (SameValueZero keys).
    pub fn addr(&self) -> usize {
        Rc::as_ptr(&self.0) as *const u8 as usize
    }
    /// Enter this value while walking a value graph (probe JSON): `None` if
    /// it is already being walked (a cycle; proxies share their storage).
    pub fn visit(&self) -> Option<Visit> {
        let a = Rc::as_ptr(&self.0.storage) as *const u8 as usize;
        VISITING.with(|v| {
            let mut v = v.borrow_mut();
            if v.contains(&a) {
                return None;
            }
            v.push(a);
            Some(Visit)
        })
    }
    /// Whether this is a proxy of deep state.
    pub fn is_owned(&self) -> bool {
        self.0.owned
    }
    /// A proxy of this value: a new identity over the same storage (itself
    /// when it already is one).
    pub fn proxy(&self) -> Self {
        if self.0.owned {
            return self.clone();
        }
        JsRef(Rc::new(Inner {
            storage: Rc::clone(&self.0.storage),
            owned: true,
        }))
    }
}

/// A value being walked (see [`JsRef::visit`]); leaving it on drop.
pub struct Visit;

impl Drop for Visit {
    fn drop(&mut self) {
        VISITING.with(|v| v.borrow_mut().pop());
    }
}

impl<T> Clone for JsRef<T> {
    fn clone(&self) -> Self {
        JsRef(Rc::clone(&self.0))
    }
}

impl<T> PartialEq for JsRef<T> {
    fn eq(&self, other: &Self) -> bool {
        JsRef::ptr_eq(self, other)
    }
}

impl<T: fmt::Debug> fmt::Debug for JsRef<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0.storage.try_borrow() {
            Ok(v) => write!(f, "&{:?}", *v),
            Err(_) => f.write_str("&<borrowed>"),
        }
    }
}

/// JavaScript arrays (dense).
pub type JsArray<T> = JsRef<Vec<T>>;

pub fn array<T>(items: Vec<T>) -> JsArray<T> {
    JsRef::new(items)
}

/// Storing a value into proxied deep state: plain objects and arrays become
/// proxies (recursively, in place), everything else is stored as is. Maps,
/// sets and functions are not proxied.
pub trait Own: Sized {
    fn own(self) -> Self {
        self
    }
}

/// Heap contents that can be proxied (arrays and records) and their nested values.
pub trait OwnFields {
    /// Whether values of this kind are proxied (false for maps and sets).
    const PROXIED: bool;
    /// Proxy the reference values held by this value.
    fn own_fields(&mut self) {}
}

impl<T: OwnFields> Own for JsRef<T> {
    fn own(self) -> Self {
        if !T::PROXIED || self.is_owned() {
            return self;
        }
        let p = self.proxy();
        // Nested values are proxied in place (not a mutation of the program's
        // data). A cycle reaches storage that is being proxied already.
        if let Ok(mut storage) = p.0.storage.try_borrow_mut() {
            storage.own_fields();
        }
        p
    }
}

impl<T: Own + Clone> OwnFields for Vec<T> {
    const PROXIED: bool = true;
    fn own_fields(&mut self) {
        for e in self.iter_mut() {
            *e = e.clone().own();
        }
    }
}

impl<T: Own> Own for Maybe<T> {
    fn own(self) -> Self {
        match self {
            Maybe::Some(v) => Maybe::Some(v.own()),
            other => other,
        }
    }
}

impl Own for f64 {}
impl Own for bool {}
impl Own for () {}
impl Own for JsString {}
impl Own for Element {}
impl<F: ?Sized> Own for Rc<F> {}

/// `v` as stored into `container`: proxied when the container is a proxy.
pub fn own_into<C, T: Own>(container: &JsRef<C>, v: T) -> T {
    if container.is_owned() { v.own() } else { v }
}
