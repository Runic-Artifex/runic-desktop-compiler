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
    /// In an app's frame before its callbacks run (`frame`).
    pub in_frame: bool,
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
            in_frame: false,
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
    /// In an app's frame, before its callbacks (its animation step), a
    /// callback requested is due in that frame (`in_frame`).
    pub fn frame(&mut self, callback: C) -> f64 {
        let delay = if self.in_frame {
            0.0
        } else {
            16.0 - self.now % 16.0
        };
        self.add(TimerKind::Frame, callback, delay)
    }

    /// `clearTimeout` / `clearInterval` / `cancelAnimationFrame`.
    pub fn clear(&mut self, id: f64) {
        self.entries.retain(|e| e.id as f64 != id);
    }

    /// Whether frame callbacks wait for the window's next frame instead of
    /// a due time: in apps (not probes), the shell's redraws are the frames,
    /// and a frame runs its callbacks after its animation events, as
    /// Chromium's "update the rendering" does (`Native::update_rendering`).
    fn frames_at_redraw() -> bool {
        !crate::probe_mode()
    }

    fn due_by_time(e: &Entry<C>) -> bool {
        e.kind != TimerKind::Frame || !Self::frames_at_redraw()
    }

    /// The due time of the next timer, frames included: an app wakes at a
    /// frame's due time to ask the window for a frame, which runs it.
    pub fn next_due(&self) -> Option<f64> {
        self.entries.iter().map(|e| e.call_at).reduce(f64::min)
    }

    /// Whether frame callbacks are due by clock time `now` and wait for the
    /// window's frame (apps). They are due on the next multiple of 16 ms
    /// after their request, so a loop of them runs at most at 62.5 frames
    /// per second however often the window redraws.
    pub fn frames_due(&self, now: f64) -> bool {
        Self::frames_at_redraw()
            && self
                .entries
                .iter()
                .any(|e| e.kind == TimerKind::Frame && e.call_at <= now)
    }

    /// Whether frame callbacks wait for the window's frames (apps).
    pub fn has_frames(&self) -> bool {
        Self::frames_at_redraw() && self.entries.iter().any(|e| e.kind == TimerKind::Frame)
    }

    /// The callbacks of the window's frame at `now` (apps): those due by
    /// then (also those requested in the frame before them), in order of
    /// request; those they request run at a later frame.
    pub fn take_frames(&mut self, now: f64) -> Vec<C> {
        self.in_frame = false;
        let mut frames = Vec::new();
        self.entries.retain(|e| {
            if e.kind == TimerKind::Frame && e.call_at <= now {
                frames.push((e.id, e.callback.clone()));
                false
            } else {
                true
            }
        });
        frames.sort_by_key(|f| f.0);
        frames.into_iter().map(|f| f.1).collect()
    }

    /// Take the first timer due at or before `to` and advance the clock to it.
    /// Intervals are rescheduled; frames receive the clock time as argument.
    pub fn take_due(&mut self, to: f64) -> Option<(TimerKind, C)> {
        let i = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.call_at <= to && Self::due_by_time(e))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Apps (not probes): frame callbacks wait for the window's frame, not a
    /// due time, so the shell is asked for one while any is pending
    /// (`Native::request_frame_if_needed`); timers keep their due times.
    #[test]
    fn app_frames_wait_for_the_window_frame() {
        let mut t: Timers<u32> = Timers::new(0.0);
        t.frame(1);
        t.add(TimerKind::Timeout, 2, 5.0);
        t.frame(3);
        assert!(t.has_frames());
        // The frames are due at the next 16 ms boundary (1008), the timeout
        // at 1005; the app wakes at each to run it or ask for a frame.
        assert_eq!(t.next_due(), Some(CLOCK_START + 5.0));
        assert!(!t.frames_due(CLOCK_START + 7.0));
        assert!(t.frames_due(CLOCK_START + 8.0));
        // Time passing runs the timeout only.
        assert_eq!(
            t.take_due(CLOCK_START + 100.0),
            Some((TimerKind::Timeout, 2))
        );
        assert!(t.take_due(CLOCK_START + 100.0).is_none());
        // The frame runs every callback due, in order.
        assert_eq!(t.take_frames(CLOCK_START + 100.0), vec![1, 3]);
        assert!(!t.has_frames());
        assert_eq!(t.next_due(), None);
        // One requested in a frame's animation step is due in that frame;
        // one requested by a frame callback, at the next boundary.
        t.now = CLOCK_START + 100.0;
        t.in_frame = true;
        t.frame(4);
        assert_eq!(t.take_frames(CLOCK_START + 100.0), vec![4]);
        t.frame(5);
        assert_eq!(t.take_frames(CLOCK_START + 100.0), Vec::<u32>::new());
        assert_eq!(t.next_due(), Some(CLOCK_START + 104.0));
    }
}
