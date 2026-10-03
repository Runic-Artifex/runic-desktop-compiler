//! Microtasks, default-priority tasks and the flush job
//! (docs/design/M4-EFFECTS.md). The first state write after an update queues
//! one flush job; the generated app runs it with the other jobs in order.

use std::collections::VecDeque;

/// A queued job: a callback, or the flush job.
pub enum Job<C> {
    Call(C),
    Flush,
}

pub struct Jobs<C> {
    microtasks: VecDeque<Job<C>>,
    /// Default-priority tasks: run after the current task's microtasks.
    defaults: VecDeque<Job<C>>,
    flush_pending: bool,
    /// While an input event is dispatched, including its microtask checkpoint.
    pub in_event: bool,
    /// Outside events, the flush job is a default task instead of a microtask.
    event_microtask: bool,
    /// Whether heap mutations (any / through proxies) queue the flush.
    tracks: (bool, bool),
    /// Heap mutation epochs at the end of the last flush.
    epochs: (u64, u64),
}

impl<C> Jobs<C> {
    pub fn new(event_microtask: bool, tracks_deep: bool, tracks_owned: bool) -> Self {
        Jobs {
            microtasks: VecDeque::new(),
            defaults: VecDeque::new(),
            flush_pending: false,
            in_event: false,
            event_microtask,
            tracks: (tracks_deep, tracks_owned),
            epochs: (runic_js::mutation_epoch(), runic_js::owned_epoch()),
        }
    }

    /// Queue the flush job unless one is pending (called by state writes).
    pub fn queue_flush(&mut self) {
        if self.flush_pending {
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

    /// The next default-priority task.
    pub fn next_default(&mut self) -> Option<Job<C>> {
        self.defaults.pop_front()
    }

    /// The flush job starts: later writes queue a new one.
    pub fn flush_started(&mut self) {
        self.flush_pending = false;
    }

    /// The flush job ended: heap mutations so far are applied.
    pub fn flush_ended(&mut self) {
        self.epochs = (runic_js::mutation_epoch(), runic_js::owned_epoch());
    }

    /// Drop queued jobs (a task whose writes were rolled back).
    pub fn clear(&mut self) {
        self.microtasks.clear();
        self.defaults.clear();
        self.flush_pending = false;
    }
}
