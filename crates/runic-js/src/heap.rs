//! Reference values (objects, arrays, maps, sets) with JavaScript identity,
//! the mutation epochs that drive "deep" cell tracking, proxies of
//! proxied deep state (Svelte's `$state`) and the slots of reactive class
//! fields (M6 stage B).

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
    static HEAP_READS: RefCell<Option<HeapFrame>> = const { RefCell::new(None) };
    /// Heap objects created so far (their creation stamps).
    static BORN: Cell<u64> = const { Cell::new(0) };
    /// A reactive class field changed, or deep state through a proxy, since
    /// [`take_signal_writes`].
    static SIGNAL_WRITES: Cell<bool> = const { Cell::new(false) };
    /// The stamp of the last heap write: every write stamps the slots it
    /// writes with a new one, so a reader can tell whether a slot was
    /// written after a point in time (an effect's own writes, R4 of
    /// docs/design/REACTIVITY-ALIASING.md).
    static STAMP: Cell<u64> = const { Cell::new(0) };
}

/// The stamp of the last heap write (see [`HeapRead::written_since`]).
pub fn heap_stamp() -> u64 {
    STAMP.with(Cell::get)
}

/// Write stamps of one heap object (shared by its proxies), for all writes
/// and for writes through proxies (`[all, owned]`). A slot is a record field
/// or, for arrays, the length (slot 0) or element `i` (slot `i + 1`).
#[derive(Default)]
struct Counts {
    /// Reachable from deep reactive state (Vue): reads of it are dependencies.
    reactive: Cell<bool>,
    /// When the object was created (see [`HeapFrame`]).
    born: u64,
    /// The last write.
    any: [Cell<u64>; 2],
    /// The last write of the whole object (all slots).
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
    /// The stamps a read of `slot` (`None`: the whole object) depends on.
    fn seen(&self, side: usize, slot: Option<u32>) -> (u64, u64) {
        match slot {
            None => (self.any[side].get(), 0),
            Some(s) => (self.whole[side].get(), self.slot(side, s)),
        }
    }
    /// Whether what a read of `slot` depends on was written after `stamp`.
    fn written_since(&self, side: usize, slot: Option<u32>, stamp: u64) -> bool {
        let (a, b) = self.seen(side, slot);
        a > stamp || b > stamp
    }
    fn write(&self, side: usize, slots: Option<&[u32]>, stamp: u64) {
        self.any[side].set(stamp);
        match slots {
            None => self.whole[side].set(stamp),
            Some(slots) => {
                let mut v = self.slots[side].borrow_mut();
                for &s in slots {
                    let s = s as usize;
                    if v.len() <= s {
                        v.resize(s + 1, 0);
                    }
                    v[s] = stamp;
                }
            }
        }
    }
}

/// A new write stamp.
fn next_stamp() -> u64 {
    STAMP.with(|s| {
        s.set(s.get() + 1);
        s.get()
    })
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
    /// Whether the slot read was written after `stamp` (see [`heap_stamp`]):
    /// by the reader itself when `stamp` is taken as it starts.
    pub fn written_since(&self, stamp: u64) -> bool {
        self.storage
            .written_since(usize::from(self.owned), self.slot, stamp)
    }
}

/// Start recording heap reads (`Some(owned_only)`) or stop (`None`); returns
/// the previous frame for [`end_heap_reads`].
pub fn begin_heap_reads(owned_only: Option<bool>) -> Option<HeapFrame> {
    let start = BORN.with(Cell::get);
    HEAP_READS.with(|t| {
        std::mem::replace(
            &mut *t.borrow_mut(),
            owned_only.map(|owned_only| HeapFrame {
                owned_only,
                reads: Vec::new(),
                start,
            }),
        )
    })
}

/// The heap reads of one running tracked effect or derived value.
pub struct HeapFrame {
    /// Only reads through proxies (and of reactive class fields) count.
    owned_only: bool,
    reads: Vec<HeapRead>,
    /// Objects created after this stamp were created by the running
    /// computation: reading their reactive fields is not a dependency, as
    /// Svelte does not track the signals a reaction creates itself.
    start: u64,
}

/// End the frame begun by [`begin_heap_reads`]: the objects and slots read,
/// each once, with their counts now (writes of the running code itself do
/// not count).
pub fn end_heap_reads(previous: Option<HeapFrame>) -> Vec<HeapRead> {
    let mine = HEAP_READS.with(|t| std::mem::replace(&mut *t.borrow_mut(), previous));
    let mut seen = std::collections::HashSet::new();
    mine.map(|f| f.reads)
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

/// Whether a reactive class field changed, or deep state was mutated
/// through a proxy, since the last call (resetting it). Template bindings
/// that may read reactive fields are re-evaluated after such writes.
pub fn take_signal_writes() -> bool {
    SIGNAL_WRITES.with(|w| w.replace(false))
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
        let born = BORN.with(|b| {
            b.set(b.get() + 1);
            b.get()
        });
        JsRef(Rc::new(Inner {
            storage: Rc::new(Storage {
                value: RefCell::new(value),
                counts: Rc::new(Counts {
                    born,
                    ..Counts::default()
                }),
            }),
            owned: false,
        }))
    }
    fn record_read(&self, slot: Option<u32>) {
        HEAP_READS.with(|t| {
            if let Some(frame) = &mut *t.borrow_mut() {
                // Through proxies (Svelte), the signals of a proxy the
                // running computation created are not its dependencies.
                let tracked = if frame.owned_only {
                    self.0.owned && self.0.storage.counts.born <= frame.start
                } else {
                    self.0.storage.counts.reactive.get()
                };
                if tracked {
                    frame.reads.push(HeapRead {
                        storage: self.0.storage.counts.clone(),
                        owned: frame.owned_only,
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
        let stamp = next_stamp();
        c.write(0, slots, stamp);
        if self.0.owned {
            OWNED_EPOCH.with(|e| e.set(e.get() + 1));
            SIGNAL_WRITES.with(|w| w.set(true));
            c.write(1, slots, stamp);
        }
    }
    /// Shared access to read reactive class field `slot`: a dependency of
    /// the running tracked effect or derived value, unless that computation
    /// created this object.
    pub fn read_signal(&self, slot: u32) -> Ref<'_, T> {
        HEAP_READS.with(|t| {
            if let Some(frame) = &mut *t.borrow_mut() {
                if self.0.storage.counts.born <= frame.start {
                    frame.reads.push(HeapRead {
                        storage: self.0.storage.counts.clone(),
                        owned: true,
                        slot: Some(slot),
                        seen: (0, 0),
                    });
                }
            }
        });
        self.0.storage.value.borrow()
    }
    /// Mutable access to write reactive class field `slot` with a value
    /// that is not `===` the old one: the dependencies of its readers change.
    pub fn write_signal(&self, slot: u32) -> RefMut<'_, T> {
        EPOCH.with(|e| e.set(e.get() + 1));
        SIGNAL_WRITES.with(|w| w.set(true));
        let c = &self.0.storage.counts;
        let stamp = next_stamp();
        c.write(0, Some(&[slot]), stamp);
        c.write(1, Some(&[slot]), stamp);
        self.0.storage.value.borrow_mut()
    }
    /// Whether writing slot `slot` would change nothing: a proxy whose slot
    /// already holds a value `same` finds `===` to the new one. Svelte's
    /// sources ignore such writes (an effect writing what it read is not
    /// invalidated by them, R4); a raw value is always written.
    pub fn unchanged(&self, _slot: u32, same: impl FnOnce(&T) -> bool) -> bool {
        self.0.owned && same(&self.0.storage.value.borrow())
    }
    /// Shared access that is not a read of the program (caches, probes).
    pub fn peek(&self) -> Ref<'_, T> {
        self.0.storage.value.borrow()
    }
    /// Mutable access that is not a write of the program (the cache of a
    /// derived class field).
    pub fn peek_mut(&self) -> RefMut<'_, T> {
        self.0.storage.value.borrow_mut()
    }
    /// A weak handle (dependencies on derived class fields).
    pub fn downgrade(&self) -> WeakRef<T> {
        WeakRef(Rc::downgrade(&self.0))
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

/// A weak handle on a [`JsRef`].
pub struct WeakRef<T>(std::rc::Weak<Inner<T>>);

impl<T> WeakRef<T> {
    pub fn upgrade(&self) -> Option<JsRef<T>> {
        self.0.upgrade().map(JsRef)
    }
}

impl<T> Clone for WeakRef<T> {
    fn clone(&self) -> Self {
        WeakRef(self.0.clone())
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
    /// Whether this value is proxied (`PROXIED`, unless the value says
    /// otherwise: the interpreter's class instance records).
    fn proxied(&self) -> bool {
        Self::PROXIED
    }
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
        if !self
            .0
            .storage
            .value
            .try_borrow()
            .map_or(true, |v| v.proxied())
        {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A record-like value that may opt out of proxying (class instances).
    struct Item {
        class: bool,
        inner: JsRef<Vec<f64>>,
    }

    impl OwnFields for Item {
        const PROXIED: bool = true;
        fn proxied(&self) -> bool {
            !self.class
        }
        fn own_fields(&mut self) {
            self.inner = self.inner.clone().own();
        }
    }

    #[test]
    fn reactive_field_slots() {
        // An instance (never a proxy) with two reactive slots.
        let instance = JsRef::new(vec![1.0, 2.0]);
        let frame = begin_heap_reads(Some(true));
        let _ = instance.read_signal(0)[0];
        // Plain reads of a raw object do not count; peeks never do.
        let _ = instance.read_slot(1)[1];
        let _ = instance.peek()[1];
        // Objects the computation creates are not its dependencies.
        let fresh = JsRef::new(vec![0.0]);
        let _ = fresh.read_signal(0)[0];
        let reads = end_heap_reads(frame);
        assert_eq!(reads.len(), 1);
        assert!(!reads[0].changed());
        // Writing another slot, or mutating without notifying, is no change.
        take_signal_writes();
        instance.write_signal(1)[1] = 3.0;
        instance.peek_mut()[0] = 5.0;
        assert!(!reads[0].changed());
        assert!(take_signal_writes() && !take_signal_writes());
        instance.write_signal(0)[0] = 4.0;
        assert!(reads[0].changed());
        // Writes through proxies are reactive writes too.
        let proxy = array(vec![1.0]).proxy();
        proxy.borrow_mut().push(2.0);
        assert!(take_signal_writes());
        // Weak handles do not keep objects alive.
        let weak = fresh.downgrade();
        assert!(weak.upgrade().is_some_and(|f| f == fresh));
        drop(fresh);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn reads_tell_writes_after_a_point() {
        // R4: a reader can tell whether what it read was written after it
        // started (its own writes); proxies a computation creates are not
        // its dependencies.
        let items = array(vec![1.0, 2.0]).proxy();
        let start = heap_stamp();
        let frame = begin_heap_reads(Some(true));
        let _ = items.read_slot(0).len();
        let fresh = array(vec![3.0]).proxy();
        let _ = fresh.read_slot(0).len();
        let reads = end_heap_reads(frame);
        assert_eq!(reads.len(), 1);
        assert!(!reads[0].written_since(start));
        // Writing another element is not a write of the length read.
        items.write_slots(&[2])[1] = 5.0;
        assert!(!reads[0].written_since(start) && !reads[0].changed());
        items.borrow_mut().pop();
        assert!(reads[0].written_since(start) && reads[0].changed());
        // A later start point does not see the write.
        assert!(!reads[0].written_since(heap_stamp()));
    }

    #[test]
    fn values_that_opt_out_are_not_proxied() {
        let plain = JsRef::new(Item {
            class: false,
            inner: array(vec![1.0]),
        });
        let owned = plain.clone().own();
        assert!(owned.is_owned() && owned != plain);
        // Nested values of a proxy are proxied in place.
        assert!(owned.borrow().inner.is_owned());

        let instance = JsRef::new(Item {
            class: true,
            inner: array(vec![1.0]),
        });
        let stored = instance.clone().own();
        // Stored as is: same identity, and what it holds stays raw.
        assert!(!stored.is_owned() && stored == instance);
        assert!(!stored.borrow().inner.is_owned());
    }
}
