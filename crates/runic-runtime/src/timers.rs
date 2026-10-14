//! Timers and animation frames with the ordering of Playwright's fake clock
//! (which the browser side of conformance runs): one queue ordered by due
//! time, creation time and id; zero delays scheduled from a timer callback
//! wait one tick; frames are due on the next multiple of 16 ms.

/// `Date.now()` at clock time 0 under test (2026-01-01T00:00:00Z), shared
/// with the reference interpreter and the browser harness.
pub const CLOCK_ORIGIN: f64 = 1_767_225_600_000.0;

/// Clock time when the app starts (the browser harness installs Playwright's
/// clock at the origin and pauses it 1000 ms later, before the page loads).
pub const CLOCK_START: f64 = 1000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimerKind {
    Timeout,
    Interval,
    Frame,
}

struct Entry<C> {
    id: u64,
    kind: TimerKind,
    callback: C,
    delay: f64,
    call_at: f64,
    created_at: f64,
}

pub struct Timers<C> {
    entries: Vec<Entry<C>>,
    next: u64,
    /// Clock time in milliseconds (`performance.now()`).
    pub now: f64,
    /// `Date.now()` at clock time 0.
    pub origin: f64,
    /// While a timer callback runs.
    pub during_tick: bool,
}

impl<C: Clone> Timers<C> {
    pub fn new(origin: f64) -> Self {
        if crate::probe_mode() {
            crate::timeline::set_virtual(CLOCK_START);
        }
        runic_js::event::set_clock(CLOCK_START);
        Timers {
            entries: Vec::new(),
            next: 1_000_000_000_000,
            now: CLOCK_START,
            origin,
            during_tick: false,
        }
    }

    /// `setTimeout` / `setInterval`; returns the timer id.
    pub fn add(&mut self, kind: TimerKind, callback: C, delay: f64) -> f64 {
        let mut delay = if delay.is_finite() { delay } else { 0.0 };
        if delay > 2_147_483_647.0 {
            delay = 1.0;
        }
        let delay = delay.max(0.0);
        let id = self.next;
        self.next += 1;
        let after = if delay != 0.0 {
            delay
        } else if self.during_tick {
            1.0
        } else {
            0.0
        };
        self.entries.push(Entry {
            id,
            kind,
            callback,
            delay,
            call_at: self.now + after,
            created_at: self.now,
        });
        id as f64
    }

    /// `requestAnimationFrame`.
    pub fn frame(&mut self, callback: C) -> f64 {
        let delay = 16.0 - self.now % 16.0;
        self.add(TimerKind::Frame, callback, delay)
    }

    /// `clearTimeout` / `clearInterval` / `cancelAnimationFrame`.
    pub fn clear(&mut self, id: f64) {
        self.entries.retain(|e| e.id as f64 != id);
    }

    /// The due time of the next timer.
    pub fn next_due(&self) -> Option<f64> {
        self.entries.iter().map(|e| e.call_at).reduce(f64::min)
    }

    /// Take the first timer due at or before `to` and advance the clock to it.
    /// Intervals are rescheduled; frames receive the clock time as argument.
    pub fn take_due(&mut self, to: f64) -> Option<(TimerKind, C)> {
        let i = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.call_at <= to)
            .min_by(|(_, a), (_, b)| {
                a.call_at
                    .total_cmp(&b.call_at)
                    .then(a.created_at.total_cmp(&b.created_at))
                    .then(a.id.cmp(&b.id))
            })
            .map(|(i, _)| i)?;
        let e = &mut self.entries[i];
        self.now = self.now.max(e.call_at);
        runic_js::event::set_clock(self.now);
        // Probes: animations follow the virtual clock (layout reads in
        // the callback resolve styles at its time).
        if crate::probe_mode() {
            crate::timeline::set_virtual(self.now);
        }
        let taken = (e.kind, e.callback.clone());
        if e.kind == TimerKind::Interval {
            e.call_at += e.delay;
        } else {
            self.entries.remove(i);
        }
        Some(taken)
    }
}

/// `Date.now()` at clock time 0: the fixed test origin in probes, the system
/// time otherwise.
pub fn clock_origin() -> f64 {
    #[cfg(feature = "probe")]
    if crate::probe::active() {
        return CLOCK_ORIGIN;
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0 - CLOCK_START)
        .unwrap_or(0.0)
}
