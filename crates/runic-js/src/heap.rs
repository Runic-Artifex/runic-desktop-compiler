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
    /// Objects read by the running tracked effect or derived value, and
    /// whether only reads through proxies count.
    static HEAP_READS: RefCell<Option<(bool, Vec<HeapRead>)>> = const { RefCell::new(None) };
}

/// Write counters of one heap object (shared by its proxies), for all writes
/// and for writes through proxies (`[all, owned]`). A slot is a record field
/// or, for arrays, the length (slot 0) or element `i` (slot `i + 1`).
#[derive(Default)]
struct Counts {
    /// Reachable from deep reactive state (Vue): reads of it are dependencies.
    reactive: Cell<bool>,
    /// Every write.
    any: [Cell<u64>; 2],
    /// Writes of the whole object (all slots).
    whole: [Cell<u64>; 2],
    slots: [RefCell<Vec<u64>>; 2],
}

impl Counts {
    fn slot(&self, side: usize, slot: u32) -> u64 {
        self.slots[side]
            .borrow()
            .get(slot as usize)
            .copied()
            .unwrap_or(0)
    }
    /// The counts a read of `slot` (`None`: the whole object) depends on.
    fn seen(&self, side: usize, slot: Option<u32>) -> (u64, u64) {
        match slot {
            None => (self.any[side].get(), 0),
            Some(s) => (self.whole[side].get(), self.slot(side, s)),
        }
    }
    fn write(&self, side: usize, slots: Option<&[u32]>) {
        let bump = |c: &Cell<u64>| c.set(c.get() + 1);
        bump(&self.any[side]);
        match slots {
            None => bump(&self.whole[side]),
            Some(slots) => {
                let mut v = self.slots[side].borrow_mut();
                for &s in slots {
                    let s = s as usize;
                    if v.len() <= s {
                        v.resize(s + 1, 0);
                    }
                    v[s] += 1;
                }
            }
        }
    }
}

struct Storage<T> {
    value: RefCell<T>,
    counts: Rc<Counts>,
}

/// A heap object (or one of its slots) a tracked effect or derived value
/// read: a changed dependency once it was written (through a proxy, where
/// only those writes are reactive).
#[derive(Clone)]
pub struct HeapRead {
    storage: Rc<Counts>,
    owned: bool,
    slot: Option<u32>,
    seen: (u64, u64),
}

impl HeapRead {
    pub fn changed(&self) -> bool {
        self.storage.seen(usize::from(self.owned), self.slot) != self.seen
    }
}

/// Start recording heap reads (`Some(owned_only)`) or stop (`None`); returns
/// the previous frame for [`end_heap_reads`].
pub fn begin_heap_reads(owned_only: Option<bool>) -> Option<(bool, Vec<HeapRead>)> {
    HEAP_READS
        .with(|t| std::mem::replace(&mut *t.borrow_mut(), owned_only.map(|o| (o, Vec::new()))))
}

/// End the frame begun by [`begin_heap_reads`]: the objects and slots read,
/// each once, with their counts now (writes of the running code itself do
/// not count).
pub fn end_heap_reads(previous: Option<(bool, Vec<HeapRead>)>) -> Vec<HeapRead> {
    let mine = HEAP_READS.with(|t| std::mem::replace(&mut *t.borrow_mut(), previous));
    let mut seen = std::collections::HashSet::new();
    mine.map(|(_, reads)| reads)
        .unwrap_or_default()
        .into_iter()
        .filter(|r| seen.insert((Rc::as_ptr(&r.storage) as *const u8 as usize, r.slot)))
        .map(|r| HeapRead {
            seen: r.storage.seen(usize::from(r.owned), r.slot),
            ..r
        })
        .collect()
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
    storage: Rc<Storage<T>>,
    /// A proxy of deep state (as opposed to the raw value).
    owned: bool,
}

/// A shared, mutable heap value; equality is identity (`===`). A proxy has its
/// own identity but shares the storage of the value it wraps.
pub struct JsRef<T>(Rc<Inner<T>>);

impl<T> JsRef<T> {
    pub fn new(value: T) -> Self {
        JsRef(Rc::new(Inner {
            storage: Rc::new(Storage {
                value: RefCell::new(value),
                counts: Rc::default(),
            }),
            owned: false,
        }))
    }
    fn record_read(&self, slot: Option<u32>) {
        HEAP_READS.with(|t| {
            if let Some((owned_only, reads)) = &mut *t.borrow_mut() {
                let tracked = if *owned_only {
                    self.0.owned
                } else {
                    self.0.storage.counts.reactive.get()
                };
                if tracked {
                    reads.push(HeapRead {
                        storage: self.0.storage.counts.clone(),
                        owned: *owned_only,
                        slot,
                        seen: (0, 0),
                    });
                }
            }
        });
    }
    fn record_write(&self, slots: Option<&[u32]>) {
        EPOCH.with(|e| e.set(e.get() + 1));
        let c = &self.0.storage.counts;
        c.write(0, slots);
        if self.0.owned {
            OWNED_EPOCH.with(|e| e.set(e.get() + 1));
            c.write(1, slots);
        }
    }
    /// Shared access to the whole value; a dependency of a running tracked
    /// effect or derived value.
    pub fn borrow(&self) -> Ref<'_, T> {
        self.record_read(None);
        self.0.storage.value.borrow()
    }
    /// Shared access to read one slot (a field, the length or an element).
    pub fn read_slot(&self, slot: u32) -> Ref<'_, T> {
        self.record_read(Some(slot));
        self.0.storage.value.borrow()
    }
    /// Mutable access to the whole value; records a heap mutation.
    pub fn borrow_mut(&self) -> RefMut<'_, T> {
        self.record_write(None);
        self.0.storage.value.borrow_mut()
    }
    /// Mutable access to write the given slots only.
    pub fn write_slots(&self, slots: &[u32]) -> RefMut<'_, T> {
        self.record_write(Some(slots));
        self.0.storage.value.borrow_mut()
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
    /// The identity of this value's storage (shared by its proxies) and a
    /// weak handle telling whether it is still alive (RegExp match arrays'
    /// extra properties, `regexp.rs`).
    pub(crate) fn storage_identity(&self) -> (usize, std::rc::Weak<dyn std::any::Any>) {
        let counts: Rc<dyn std::any::Any> = self.0.storage.counts.clone();
        (
            Rc::as_ptr(&self.0.storage.counts) as *const u8 as usize,
            Rc::downgrade(&counts),
        )
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
        match self.0.storage.value.try_borrow() {
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
    /// Mark the heap values reachable from this value as reactive (stored
    /// into deep state: their reads become effect dependencies).
    fn mark(&self) {}
}

/// Heap contents that can be proxied (arrays and records) and their nested values.
pub trait OwnFields {
    /// Whether values of this kind are proxied (false for maps and sets).
    const PROXIED: bool;
    /// Proxy the reference values held by this value.
    fn own_fields(&mut self) {}
    /// Mark the reference values held by this value as reactive.
    fn mark_fields(&self) {}
}

impl<T: OwnFields> Own for JsRef<T> {
    fn mark(&self) {
        if self.0.storage.counts.reactive.replace(true) {
            return;
        }
        if let Ok(v) = self.0.storage.value.try_borrow() {
            v.mark_fields();
        }
    }
    fn own(self) -> Self {
        if !T::PROXIED || self.is_owned() {
            return self;
        }
        let p = self.proxy();
        // Nested values are proxied in place (not a mutation of the program's
        // data). A cycle reaches storage that is being proxied already.
        if let Ok(mut storage) = p.0.storage.value.try_borrow_mut() {
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
    fn mark_fields(&self) {
        for e in self {
            e.mark();
        }
    }
}

impl<T: Own> Own for Maybe<T> {
    fn mark(&self) {
        if let Maybe::Some(v) = self {
            v.mark();
        }
    }
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

/// `v` as stored into `container`: proxied when the container is a proxy,
/// marked reactive when the container is.
pub fn own_into<C, T: Own>(container: &JsRef<C>, v: T) -> T {
    if container.is_owned() {
        return v.own();
    }
    if container.0.storage.counts.reactive.get() {
        v.mark();
    }
    v
}
