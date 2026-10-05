//! Microtasks, default-priority tasks and the flush job
//! (docs/design/M4-EFFECTS.md). The first state write after an update queues
//! one flush job; the generated app runs it with the other jobs in order.

use std::collections::VecDeque;

/// A queued job: a callback, or the flush job.
pub enum Job<C> {
    Call(C),
    Flush,
    /// Run any pending flush now, then the callback (`flush.tick`).
    FlushThen(C),
    /// Report the rejections a microtask checkpoint left without a reaction
    /// (a default-priority task, as Chromium posts it; docs/IR.md, promises).
    Report(runic_js::Rejections),
}

pub struct Jobs<C> {
    microtasks: VecDeque<Job<C>>,
    /// Default-priority tasks: run after the current task's microtasks.
    defaults: VecDeque<Job<C>>,
    flush_pending: bool,
    /// While an input event is dispatched, including its microtask checkpoint.
    pub in_event: bool,
    /// While a discrete input event's listeners run (not its checkpoint):
    /// React gives updates the discrete priority only then.
    pub dispatching: bool,
    /// Outside events, the flush job is a default task instead of a microtask.
    event_microtask: bool,
    /// Whether heap mutations (any / through proxies) queue the flush.
    tracks: (bool, bool),
    /// Heap mutation epochs at the end of the last flush.
    epochs: (u64, u64),
    /// The effect phase of a running flush: writes then ask for another pass.
    pub phase: Option<Phase>,
    /// A write during the running flush asks for another pass.
    pub again: bool,
    /// Writes from post effects update in a later default task.
    post_writes_deferred: bool,
    /// Source of cell versions (bumped by writes that change a cell).
    clock: u64,
}

/// The phases of a flush (docs/design/M4-EFFECTS.md).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Pre,
    Layout,
    Post,
}

impl<C> Jobs<C> {
    pub fn new(
        event_microtask: bool,
        tracks_deep: bool,
        tracks_owned: bool,
        post_writes_deferred: bool,
    ) -> Self {
        Jobs {
            phase: None,
            again: false,
            post_writes_deferred,
            clock: 0,
            microtasks: VecDeque::new(),
            defaults: VecDeque::new(),
            flush_pending: false,
            in_event: false,
            dispatching: false,
            event_microtask,
            tracks: (tracks_deep, tracks_owned),
            epochs: (runic_js::mutation_epoch(), runic_js::owned_epoch()),
        }
    }

    /// Queue the flush job unless one is pending (called by state writes).
    pub fn queue_flush(&mut self) {
        if let Some(phase) = self.phase {
            if phase == Phase::Post && self.post_writes_deferred {
                if !self.flush_pending {
                    self.flush_pending = true;
                    self.defaults.push_back(Job::Flush);
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
            if self.event_microtask && self.dispatching {
                if let Some(i) = self.defaults.iter().position(|j| matches!(j, Job::Flush)) {
                    self.defaults.remove(i);
                    self.microtasks.push_back(Job::Flush);
                }
            }
            return;
        }
        self.flush_pending = true;
        if self.event_microtask && !self.in_event {
            self.defaults.push_back(Job::Flush);
        } else {
            self.microtasks.push_back(Job::Flush);
        }
    }

    /// Queue the flush job if tracked heap values were mutated since the last
    /// flush. Checked before anything else is queued, which orders the flush
    /// exactly as if it had been queued at the mutation.
    pub fn note_mutations(&mut self) {
        let (deep, owned) = self.mutated();
        if (self.tracks.0 && deep) || (self.tracks.1 && owned) {
            self.queue_flush();
        }
    }

    /// Whether the heap was mutated (at all, through proxies) since the last flush.
    pub fn mutated(&self) -> (bool, bool) {
        (
            runic_js::mutation_epoch() != self.epochs.0,
            runic_js::owned_epoch() != self.epochs.1,
        )
    }

    /// A microtask that runs any pending flush, then `callback`.
    pub fn queue_flush_then(&mut self, callback: C) {
        self.note_mutations();
        self.microtasks.push_back(Job::FlushThen(callback));
    }

    /// Take the pending flush out of the queues (to run it now).
    pub fn take_flush(&mut self) -> bool {
        if !self.flush_pending {
            return false;
        }
        self.microtasks.retain(|j| !matches!(j, Job::Flush));
        self.defaults.retain(|j| !matches!(j, Job::Flush));
        true
    }

    /// Whether a flush is pending or running.
    pub fn flushing(&self) -> bool {
        self.flush_pending || self.phase.is_some()
    }

    /// `queueMicrotask`.
    pub fn queue(&mut self, callback: C) {
        self.note_mutations();
        self.microtasks.push_back(Job::Call(callback));
    }

    /// The next microtask of the current checkpoint.
    pub fn next_microtask(&mut self) -> Option<Job<C>> {
        self.note_mutations();
        self.microtasks.pop_front()
    }

    /// At the end of a microtask checkpoint: the rejections it left without
    /// a reaction are reported by a default-priority task queued now.
    pub fn queue_rejections(&mut self) {
        let r = runic_js::take_rejections();
        if !r.is_empty() {
            self.defaults.push_back(Job::Report(r));
        }
    }

    /// The number of default-priority tasks queued.
    pub fn defaults_len(&self) -> usize {
        self.defaults.len()
    }

    /// The next default-priority task.
    pub fn next_default(&mut self) -> Option<Job<C>> {
        self.defaults.pop_front()
    }

    /// The flush job starts: later writes extend it or queue a new one.
    pub fn flush_started(&mut self) {
        self.flush_pending = false;
        self.phase = Some(Phase::Pre);
    }

    /// Whether the heap was mutated since the last call (or flush), resetting.
    pub fn take_mutated(&mut self) -> (bool, bool) {
        let m = self.mutated();
        self.epochs = (runic_js::mutation_epoch(), runic_js::owned_epoch());
        m
    }

    /// The flush job ended: heap mutations so far are applied.
    pub fn flush_ended(&mut self) {
        self.phase = None;
        self.epochs = (runic_js::mutation_epoch(), runic_js::owned_epoch());
    }

    /// A ref cell set or cleared while rendering: another pass of the
    /// running flush handles it.
    pub fn ref_written(&mut self) {
        if self.phase.is_some() {
            self.again = true;
        }
    }

    /// Queue the mount's flush (a microtask or a default task) unless one is pending.
    pub fn queue_mount(&mut self, task: bool) {
        if self.flush_pending {
            return;
        }
        self.flush_pending = true;
        if task {
            self.defaults.push_back(Job::Flush);
        } else {
            self.microtasks.push_back(Job::Flush);
        }
    }

    /// A new cell version.
    pub fn version(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// Drop queued jobs (a task whose writes were rolled back).
    pub fn clear(&mut self) {
        self.microtasks.clear();
        self.defaults.clear();
        self.flush_pending = false;
    }
}

/// Cell versions of a component instance (tracked effect dependencies).
pub trait Versions {
    fn version(&self, cell: usize) -> u64;
}

/// Instance state with per-cell versions (implemented by generated code).
pub trait CellVersions {
    fn versions(&self) -> &[u64];
}

impl<T: CellVersions> Versions for std::cell::RefCell<T> {
    fn version(&self, cell: usize) -> u64 {
        self.borrow().versions()[cell]
    }
}

/// A read recorded while a tracked effect or a derived value ran: a cell
/// (`cells`), or a derived value (`refresh` brings it up to date and gives
/// its version). `X` is the generated app's context.
pub struct Dep<X> {
    pub cells: Option<std::rc::Rc<dyn Versions>>,
    pub cell: usize,
    pub refresh: Option<std::rc::Rc<dyn Fn(&mut X) -> u64>>,
    pub version: u64,
    /// A heap object read (deep state changes through its objects).
    pub heap: Option<runic_js::HeapRead>,
}

impl<X> Clone for Dep<X> {
    fn clone(&self) -> Self {
        Dep {
            cells: self.cells.clone(),
            cell: self.cell,
            refresh: self.refresh.clone(),
            version: self.version,
            heap: self.heap.clone(),
        }
    }
}

impl<X> Dep<X> {
    /// The objects read while a tracked effect or derived value ran.
    pub fn heap(reads: Vec<runic_js::HeapRead>) -> impl Iterator<Item = Dep<X>> {
        reads.into_iter().map(|h| Dep {
            cells: None,
            cell: 0,
            refresh: None,
            version: 0,
            heap: Some(h),
        })
    }

    /// Whether the cell was written (or, for deep state, the heap mutated)
    /// since, or the derived value changed.
    pub fn changed(&self, cx: &mut X) -> bool {
        if let Some(refresh) = &self.refresh {
            return refresh(cx) != self.version;
        }
        if let Some(h) = &self.heap {
            return h.changed();
        }
        self.cells
            .as_ref()
            .is_some_and(|c| c.version(self.cell) != self.version)
    }
}

/// A cached derived value of an instance.
pub struct Derived<T, X> {
    pub cached: T,
    pub deps: Vec<Dep<X>>,
    /// Bumped when a recomputation gives a different value.
    pub version: u64,
}

/// Derived class fields live in records, which are cloneable.
impl<T: Clone, X> Clone for Derived<T, X> {
    fn clone(&self) -> Self {
        Derived {
            cached: self.cached.clone(),
            deps: self.deps.clone(),
            version: self.version,
        }
    }
}

/// The run state of one effect of an instance.
pub struct Fx<C, X> {
    pub started: bool,
    pub cleanup: Option<C>,
    pub deps: Vec<Dep<X>>,
}

impl<C, X> Default for Fx<C, X> {
    fn default() -> Self {
        Fx {
            started: false,
            cleanup: None,
            deps: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_discrete_write_renders_a_pending_default_flush_in_its_microtask() {
        // React's schedule: a flush outside input events is a default task.
        let mut jobs: Jobs<()> = Jobs::new(true, false, false, false);
        jobs.queue_flush();
        assert_eq!(jobs.defaults_len(), 1);
        // A write while a discrete event is dispatched moves it.
        jobs.in_event = true;
        jobs.dispatching = true;
        jobs.queue_flush();
        assert_eq!(jobs.defaults_len(), 0);
        assert!(matches!(jobs.next_microtask(), Some(Job::Flush)));
        // In the event's checkpoint (after its dispatch) it stays a default task.
        let mut jobs: Jobs<()> = Jobs::new(true, false, false, false);
        jobs.queue_flush();
        jobs.in_event = true;
        jobs.queue_flush();
        assert_eq!(jobs.defaults_len(), 1);
        assert!(jobs.next_microtask().is_none());
    }
}
