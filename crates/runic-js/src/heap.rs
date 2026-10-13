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
    /// Proxies of this array whose elements are not all taken yet (R3):
    /// changing it in place other than through them is reported.
    overlays: Cell<usize>,
    /// A proxy's value before its first write since the last flush ended
    /// (R5), with that flush count.
    before: RefCell<Option<(u64, T)>>,
}

impl<T> Storage<T> {
    fn new(value: T) -> Self {
        let born = BORN.with(|b| {
            b.set(b.get() + 1);
            b.get()
        });
        Storage {
            value: RefCell::new(value),
            counts: Rc::new(Counts {
                born,
                ..Counts::default()
            }),
            overlays: Cell::new(0),
            before: RefCell::new(None),
        }
    }
}

thread_local! {
    /// Whether proxies keep before-images (R5: programs whose teardowns read
    /// the values before the flush).
    static BEFORE_IMAGES: Cell<bool> = const { Cell::new(false) };
    /// While a teardown runs: reads through proxies give before-images.
    static READING_PREVIOUS: Cell<bool> = const { Cell::new(false) };
    /// Flushes ended so far (before-images belong to one).
    static FLUSHES: Cell<u64> = const { Cell::new(0) };
    /// The first behaviour the heap could not reproduce since the last
    /// [`take_heap_unsupported`].
    static UNSUPPORTED: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Proxies keep their values before the flush for teardowns (R5 of
/// docs/design/REACTIVITY-ALIASING.md; Svelte's `old_values`).
pub fn keep_before_images(on: bool) {
    BEFORE_IMAGES.with(|b| b.set(on));
}

/// Reads through proxies give their values before the flush (while a
/// teardown runs); returns the previous setting.
pub fn set_reading_previous(on: bool) -> bool {
    READING_PREVIOUS.with(|r| r.replace(on))
}

/// A flush ended: the next write starts a new before-image.
pub fn flush_ended() {
    FLUSHES.with(|f| f.set(f.get() + 1));
}

/// An unsupported change the heap saw (reported by the runtime and the
/// interpreter, as `RunicUnsupportedError`).
pub fn take_heap_unsupported() -> Option<String> {
    UNSUPPORTED.with(|u| u.borrow_mut().take())
}

/// The slots of a proxy not taken from its target yet (R3 of
/// docs/design/REACTIVITY-ALIASING.md): Svelte's proxy creates the source of
/// a property at its first access, from the target's value at that moment,
/// and proxies a plain object or array it holds then.
struct Lazy<T> {
    target: Rc<Storage<T>>,
    /// Per slot: not taken yet.
    pending: Vec<bool>,
    left: usize,
    /// Take slot `slot` of the target into the proxy's value, proxied.
    take: fn(&mut T, &T, u32),
    /// What a read of pending slot `slot` would give, unproxied (probes).
    look: fn(&mut T, &T, u32),
    /// An array's (counted in its target's `overlays` while pending).
    elements: bool,
}

impl<T> Drop for Lazy<T> {
    fn drop(&mut self) {
        if self.elements && self.left > 0 {
            self.target.overlays.set(self.target.overlays.get() - 1);
        }
    }
}

/// How a proxy takes the slots of its target (see [`OwnFields::overlay`]).
pub enum Overlay {
    /// Record fields, each taken from the target at its first access.
    Fields(usize),
    /// Array elements: the length and values when the proxy is created, each
    /// element proxied at its first access.
    Elements(usize),
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
    /// A proxy's target (R3): the raw value it was made of.
    target: Option<Rc<Storage<T>>>,
    /// A proxy's slots not taken from its target yet.
    lazy: RefCell<Option<Lazy<T>>>,
    /// A proxy's copy of its value (before-images, R5).
    image: Option<fn(&T) -> T>,
}

/// A value read without taking a proxy's pending slots (probes).
pub enum Probe<'a, T> {
    Borrowed(Ref<'a, T>),
    Owned(T),
}

impl<T> std::ops::Deref for Probe<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        match self {
            Probe::Borrowed(r) => r,
            Probe::Owned(v) => v,
        }
    }
}

/// A shared, mutable heap value; equality is identity (`===`). A proxy has
/// its own identity and its own storage, taken from the value it was made of
/// slot by slot (R3).
pub struct JsRef<T>(Rc<Inner<T>>);

impl<T> JsRef<T> {
    pub fn new(value: T) -> Self {
        JsRef(Rc::new(Inner {
            storage: Rc::new(Storage::new(value)),
            owned: false,
            target: None,
            lazy: RefCell::new(None),
            image: None,
        }))
    }
    /// Keep the value before the first write since the last flush ended
    /// (a proxy's, where teardowns read the values before the flush).
    fn capture(&self) {
        let Some(image) = self.0.image else {
            return;
        };
        if !BEFORE_IMAGES.with(Cell::get) {
            return;
        }
        let now = FLUSHES.with(Cell::get);
        let mut before = self.0.storage.before.borrow_mut();
        if before.as_ref().is_some_and(|(e, _)| *e == now) {
            return;
        }
        let mut v = image(&self.0.storage.value.borrow());
        // (Slots not taken yet: as a read would give them.)
        if let Some(l) = &*self.0.lazy.borrow() {
            let target = l.target.value.borrow();
            for (s, pending) in l.pending.iter().enumerate() {
                if *pending {
                    (l.look)(&mut v, &target, s as u32);
                }
            }
        }
        *before = Some((now, v));
    }
    /// While a teardown runs, a proxy written since the last flush ended
    /// reads as it was before (Svelte's `old_values`).
    fn previous(&self) -> Option<Ref<'_, T>> {
        if !self.0.owned || !READING_PREVIOUS.with(Cell::get) {
            return None;
        }
        let now = FLUSHES.with(Cell::get);
        let before = self.0.storage.before.borrow();
        if !before.as_ref().is_some_and(|(e, _)| *e == now) {
            return None;
        }
        Some(Ref::map(before, |b| &b.as_ref().expect("checked").1))
    }
    /// Take slot `slot` (`None`: every slot) from the target, before the
    /// program reads or changes it through this proxy.
    fn settle(&self, slot: Option<u32>) {
        let mut lazy = self.0.lazy.borrow_mut();
        let Some(l) = lazy.as_mut() else {
            return;
        };
        {
            let target = l.target.value.borrow();
            let mut own = self.0.storage.value.borrow_mut();
            let range = match slot {
                Some(s) if (s as usize) < l.pending.len() => s as usize..s as usize + 1,
                Some(_) => 0..0,
                None => 0..l.pending.len(),
            };
            for s in range {
                if l.pending[s] {
                    l.pending[s] = false;
                    l.left -= 1;
                    (l.take)(&mut own, &target, s as u32);
                }
            }
        }
        if l.left == 0 {
            if l.elements {
                l.target.overlays.set(l.target.overlays.get() - 1);
            }
            *lazy = None;
        }
    }
    /// Slots the program overwrites: no longer taken from the target.
    fn overwrite(&self, slots: &[u32]) {
        let mut lazy = self.0.lazy.borrow_mut();
        let Some(l) = lazy.as_mut() else {
            return;
        };
        for &s in slots {
            if l.pending.get(s as usize).copied().unwrap_or(false) {
                l.pending[s as usize] = false;
                l.left -= 1;
            }
        }
        if l.left == 0 {
            if l.elements {
                l.target.overlays.set(l.target.overlays.get() - 1);
            }
            *lazy = None;
        }
    }
    /// A raw in-place change of an array a proxy has not taken every
    /// element of: Svelte's proxy would show the target's new elements at
    /// the indices it has not read, under its old length (R3).
    fn note_raw_write(&self) {
        if !self.0.owned && self.0.storage.overlays.get() > 0 {
            UNSUPPORTED.with(|u| {
                u.borrow_mut().get_or_insert_with(|| {
                    "an array stored in $state was changed in place other than through its proxy (Svelte's proxy would show its new elements at indices it has not read)".into()
                });
            });
        }
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
    /// was taken and already holds a value `same` finds `===` to the new
    /// one. Svelte's sources ignore such writes (an effect writing what it
    /// read is not invalidated by them, R4); a slot never accessed gets a
    /// source at the write, so writing it is a change; a raw value is always
    /// written.
    pub fn unchanged(&self, slot: u32, same: impl FnOnce(&T) -> bool) -> bool {
        let pending = self
            .0
            .lazy
            .borrow()
            .as_ref()
            .is_some_and(|l| l.pending.get(slot as usize).copied().unwrap_or(false));
        self.0.owned && !pending && same(&self.0.storage.value.borrow())
    }
    /// Shared access that is not a read of the program (caches, probes).
    pub fn peek(&self) -> Ref<'_, T> {
        self.0.storage.value.borrow()
    }
    /// Shared access to the whole value as the program reads it (a proxy's
    /// pending slots taken), not a dependency: style objects and
    /// floating-ui options read by built-ins.
    pub fn peek_settled(&self) -> Ref<'_, T> {
        self.settle(None);
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
        if let Some(v) = self.previous() {
            return v;
        }
        self.settle(None);
        self.record_read(None);
        self.0.storage.value.borrow()
    }
    /// Shared access to read one slot (a field, the length or an element).
    pub fn read_slot(&self, slot: u32) -> Ref<'_, T> {
        if let Some(v) = self.previous() {
            return v;
        }
        self.settle(Some(slot));
        self.record_read(Some(slot));
        self.0.storage.value.borrow()
    }
    /// Mutable access to the whole value; records a heap mutation.
    pub fn borrow_mut(&self) -> RefMut<'_, T> {
        self.settle(None);
        self.capture();
        self.note_raw_write();
        self.record_write(None);
        self.0.storage.value.borrow_mut()
    }
    /// Mutable access to write the given slots only.
    pub fn write_slots(&self, slots: &[u32]) -> RefMut<'_, T> {
        self.capture();
        self.overwrite(slots);
        self.note_raw_write();
        self.record_write(Some(slots));
        self.0.storage.value.borrow_mut()
    }
    /// The value as the program would read it now, without taking a proxy's
    /// pending slots (probes and snapshots must not change what later reads
    /// see).
    pub fn probe(&self) -> Probe<'_, T>
    where
        T: Clone,
    {
        let lazy = self.0.lazy.borrow();
        match &*lazy {
            None => Probe::Borrowed(self.0.storage.value.borrow()),
            Some(l) => {
                let mut v = self.0.storage.value.borrow().clone();
                let target = l.target.value.borrow();
                for (s, pending) in l.pending.iter().enumerate() {
                    if *pending {
                        (l.look)(&mut v, &target, s as u32);
                    }
                }
                Probe::Owned(v)
            }
        }
    }
    pub fn ptr_eq(a: &Self, b: &Self) -> bool {
        Rc::ptr_eq(&a.0, &b.0)
    }
    /// Stable identity for hashing (SameValueZero keys).
    pub fn addr(&self) -> usize {
        Rc::as_ptr(&self.0) as *const u8 as usize
    }
    /// Enter this value while walking a value graph (probe JSON): `None` if
    /// it is already being walked (a cycle).
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
    /// The identity of this value's storage (a proxy's: its target's) and a
    /// weak handle telling whether it is still alive (RegExp match arrays'
    /// extra properties, `regexp.rs`, which a proxy reads from its target).
    pub(crate) fn storage_identity(&self) -> (usize, std::rc::Weak<dyn std::any::Any>) {
        let storage = self.0.target.as_ref().unwrap_or(&self.0.storage);
        let counts: Rc<dyn std::any::Any> = storage.counts.clone();
        (
            Rc::as_ptr(&storage.counts) as *const u8 as usize,
            Rc::downgrade(&counts),
        )
    }
    /// Whether this is a proxy of deep state.
    pub fn is_owned(&self) -> bool {
        self.0.owned
    }
    /// A proxy of this value (itself when it already is one): a new
    /// identity with its own storage and signals, which takes each slot from
    /// this value at its first access and never writes this value (R3).
    pub fn proxy(&self) -> Self
    where
        T: OwnFields,
    {
        if self.0.owned {
            return self.clone();
        }
        let value = self.0.storage.value.borrow().clone();
        let (pending, elements) = match value.overlay() {
            Overlay::Fields(n) => (vec![true; n], false),
            // (An array's length is taken when the proxy is made.)
            Overlay::Elements(n) => (
                std::iter::once(false)
                    .chain(std::iter::repeat_n(true, n))
                    .collect::<Vec<_>>(),
                true,
            ),
        };
        let left = pending.iter().filter(|p| **p).count();
        let lazy = (left > 0).then(|| {
            if elements {
                self.0
                    .storage
                    .overlays
                    .set(self.0.storage.overlays.get() + 1);
            }
            Lazy {
                target: Rc::clone(&self.0.storage),
                pending,
                left,
                take: T::take_slot,
                look: T::look_slot,
                elements,
            }
        });
        JsRef(Rc::new(Inner {
            storage: Rc::new(Storage::new(value)),
            owned: true,
            target: Some(Rc::clone(&self.0.storage)),
            lazy: RefCell::new(lazy),
            image: Some(T::clone),
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
/// proxies (what they hold when it is first accessed through them),
/// everything else is stored as is. Maps, sets and functions are not
/// proxied.
pub trait Own: Sized {
    fn own(self) -> Self {
        self
    }
    /// Mark the heap values reachable from this value as reactive (stored
    /// into deep state: their reads become effect dependencies).
    fn mark(&self) {}
}

/// Heap contents that can be proxied (arrays and records) and their nested values.
pub trait OwnFields: Clone {
    /// Whether values of this kind are proxied (false for maps and sets).
    const PROXIED: bool;
    /// Whether this value is proxied (`PROXIED`, unless the value says
    /// otherwise: the interpreter's class instance records).
    fn proxied(&self) -> bool {
        Self::PROXIED
    }
    /// How a proxy of this value takes its slots (R3).
    fn overlay(&self) -> Overlay {
        Overlay::Fields(0)
    }
    /// A proxy's first access to slot `slot`: record fields take the
    /// target's value (`target`), proxied; arrays proxy the element their
    /// copy holds (slot `i + 1`).
    fn take_slot(&mut self, _target: &Self, _slot: u32) {}
    /// What a read of a pending slot would give, unproxied (probes).
    fn look_slot(&mut self, _target: &Self, _slot: u32) {}
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
        self.proxy()
    }
}

impl<T: Own + Clone> OwnFields for Vec<T> {
    const PROXIED: bool = true;
    fn overlay(&self) -> Overlay {
        Overlay::Elements(self.len())
    }
    fn take_slot(&mut self, _target: &Self, slot: u32) {
        if let Some(e) = (slot as usize).checked_sub(1).and_then(|i| self.get_mut(i)) {
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

    /// A record-like value (slot 1: `inner`) that may opt out of proxying
    /// (class instances).
    #[derive(Clone)]
    struct Item {
        class: bool,
        inner: JsRef<Vec<f64>>,
    }

    impl OwnFields for Item {
        const PROXIED: bool = true;
        fn proxied(&self) -> bool {
            !self.class
        }
        fn overlay(&self) -> Overlay {
            Overlay::Fields(2)
        }
        fn take_slot(&mut self, target: &Self, slot: u32) {
            if slot == 1 {
                self.inner = target.inner.clone().own();
            }
        }
        fn look_slot(&mut self, target: &Self, slot: u32) {
            if slot == 1 {
                self.inner = target.inner.clone();
            }
        }
    }

    #[test]
    fn proxies_take_their_target_lazily_and_never_write_it() {
        let raw = JsRef::new(Item {
            class: false,
            inner: array(vec![1.0]),
        });
        let p = raw.clone().own();
        // A raw write before the proxy's first access is visible.
        let other = array(vec![7.0]);
        raw.write_slots(&[1]).inner = other.clone();
        assert!(p.probe().inner == other);
        let inner = p.read_slot(1).inner.clone();
        assert!(inner.is_owned() && inner != other);
        assert_eq!(inner.borrow()[0], 7.0);
        assert!(p.read_slot(1).inner == inner);
        // Writes through the proxy leave the target as it was.
        inner.borrow_mut().push(8.0);
        assert_eq!(other.borrow().len(), 1);
        assert_eq!(inner.borrow().len(), 2);
        // A raw write after the first access is not visible.
        raw.write_slots(&[1]).inner = array(vec![9.0]);
        assert!(p.read_slot(1).inner == inner);
        // Two proxies of one raw value are independent.
        let q = raw.clone().own();
        assert!(q != p && q.read_slot(1).inner.borrow()[0] == 9.0);
        assert!(take_heap_unsupported().is_none());
        // An array keeps its length and values from when it was proxied;
        // changing it in place while elements are pending is reported, after
        // they were all taken it is not.
        let xs = array(vec![1.0, 2.0]);
        let px = xs.clone().own();
        xs.borrow_mut().push(3.0);
        assert!(take_heap_unsupported().is_some());
        assert_eq!(px.read_slot(0).len(), 2);
        let _ = px.borrow();
        xs.borrow_mut().push(4.0);
        assert!(take_heap_unsupported().is_none());
        assert_eq!(xs.borrow().len(), 4);
        assert_eq!(px.borrow().len(), 2);
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
    fn teardowns_read_proxies_as_before_the_flush() {
        // R5: Svelte's old_values hold the value before the first write
        // since the last flush; teardowns read them.
        keep_before_images(true);
        let p = JsRef::new(Item {
            class: false,
            inner: array(vec![1.0]),
        })
        .own();
        let inner = p.read_slot(1).inner.clone();
        flush_ended();
        inner.borrow_mut().push(2.0);
        inner.borrow_mut().push(3.0);
        let was = set_reading_previous(true);
        assert_eq!(inner.read_slot(0).len(), 1);
        set_reading_previous(was);
        assert_eq!(inner.read_slot(0).len(), 3);
        // After the flush the image is gone.
        flush_ended();
        set_reading_previous(true);
        assert_eq!(inner.read_slot(0).len(), 3);
        set_reading_previous(false);
        keep_before_images(false);
    }

    #[test]
    fn values_that_opt_out_are_not_proxied() {
        let plain = JsRef::new(Item {
            class: false,
            inner: array(vec![1.0]),
        });
        let owned = plain.clone().own();
        assert!(owned.is_owned() && owned != plain);
        // Nested values are proxied when the proxy reads them; the raw value
        // keeps its own.
        assert!(owned.borrow().inner.is_owned());
        assert!(!plain.borrow().inner.is_owned());

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
