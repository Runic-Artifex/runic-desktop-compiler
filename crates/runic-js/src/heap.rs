//! Reference values (objects, arrays, maps, sets) with JavaScript identity,
//! and the mutation epoch that drives "deep" cell tracking.

use std::cell::{Cell, Ref, RefCell, RefMut};
use std::fmt;
use std::rc::Rc;

thread_local! {
    static EPOCH: Cell<u64> = const { Cell::new(0) };
}

/// Incremented by every mutable access to a heap value. A handler compares
/// the epoch before and after to decide whether deep-tracked cells may have
/// changed (docs/design/M2-VALUES.md).
pub fn mutation_epoch() -> u64 {
    EPOCH.with(Cell::get)
}

/// A shared, mutable heap value; equality is identity (`===`).
pub struct JsRef<T>(Rc<RefCell<T>>);

impl<T> JsRef<T> {
    pub fn new(value: T) -> Self {
        JsRef(Rc::new(RefCell::new(value)))
    }
    pub fn borrow(&self) -> Ref<'_, T> {
        self.0.borrow()
    }
    /// Mutable access; records a heap mutation.
    pub fn borrow_mut(&self) -> RefMut<'_, T> {
        EPOCH.with(|e| e.set(e.get() + 1));
        self.0.borrow_mut()
    }
    pub fn ptr_eq(a: &Self, b: &Self) -> bool {
        Rc::ptr_eq(&a.0, &b.0)
    }
    /// Stable identity for hashing (SameValueZero keys).
    pub fn addr(&self) -> usize {
        Rc::as_ptr(&self.0) as *const u8 as usize
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
        match self.0.try_borrow() {
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
